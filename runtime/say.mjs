#!/usr/bin/env node
// 文字 → 语音（TTS + RVC 变声）→ 发到 QQ
//
// 用法：
//   node voice/say.mjs --text "你好呀" --voice kikiV1 --key private:2311464997 --token <agentToken>
//   node voice/say.mjs --text "你好呀" --direct            # 绕过桥接，直接用 SnowLuma 发
//   node voice/say.mjs --text "你好呀" --no-rvc --dry      # 只生成不发送
//
// 输出：--json 时打印一行 JSON 结果；否则打印可读摘要。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.VOICE_CONFIG || path.join(__dirname, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'voice.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);

const text = String(arg('text', '') || '').trim();
const voice = String(arg('voice', CFG.rvc?.defaultVoice || '') || '');
const pitch = Number(arg('pitch', CFG.rvc?.pitch ?? 0));
const key = arg('key', null);
const token = arg('token', null);
const direct = has('direct');
const noRvc = has('no-rvc');
const dry = has('dry');
// 情绪 = 8 维向量 [高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
// 优先级：--vector 显式向量 > --emotion 命名预设 > 默认由她当前心情（personality.mood）映射
// 通用情绪预设：维度压低，优先保住音色（高维会改嗓子）；哭腔另行处理
const EMOTION_PRESETS = {
  开心: [0.45, 0, 0, 0, 0, 0, 0, 0.55],
  激动: [0.40, 0, 0, 0, 0, 0, 0.15, 0.45],
  温柔: [0.25, 0, 0, 0, 0, 0, 0, 0.75],
  撒娇: [0.30, 0, 0, 0, 0, 0, 0, 0.70],
  生气: [0, 1.00, 0, 0, 0.20, 0, 0, 0.00],
  委屈: [0, 0, 0.30, 0, 0, 0.50, 0, 0.20],
  难过: [0, 0, 0.55, 0, 0, 0.30, 0, 0.15],
  伤心: [0, 0, 0.60, 0, 0, 0.35, 0, 0.10],
  哭腔: [0, 0, 0.85, 0, 0, 0.45, 0, 0.05],
  惊讶: [0.10, 0, 0, 0, 0, 0, 0.40, 0.50],
  平静: [0, 0, 0, 0, 0, 0, 0, 1.0],
};
// 她当前情绪状态 → 8 维向量（情绪推演模块维护的 emotion-state.json）
function inferEmotionName(v) {
  if (!Array.isArray(v) || v.length !== 8) return '';
  const [happy, angry, sad, afraid, disgust, down, surprised, calm] = v.map((x) => Number(x) || 0);
  if (angry >= 0.45) return '生气';
  if (sad >= 0.35 || down >= 0.55) return sad >= 0.35 ? '伤心' : '难过';
  if (happy >= 0.3) return '开心';
  if (surprised >= 0.45) return '惊讶';
  if (calm >= 0.65) return '温柔';
  return '';
}

function stateAlpha() {
  return Number(CFG.indextts2?.stateAlpha ?? 0.4);
}

function stateVector() {
  try {
    const dir = process.env.MEMORY_DIR || path.join(os.homedir(), '.dsh', 'qq-memory');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'emotion-state.json'), 'utf8'));
    const v = st?.self?.vector;
    if (Array.isArray(v) && v.length === 8) {
      vectorSource = 'state';
      return v.map((x) => Math.max(0, Number(x) || 0));
    }
  } catch {
    /* 没有状态文件 */
  }
  return null;
}

// 她当前心情 → 情绪向量（读 personality.json 的 mood.valence / energy）
function moodVector() {
  try {
    const dir = process.env.MEMORY_DIR || path.join(os.homedir(), '.dsh', 'qq-memory');
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'personality.json'), 'utf8'));
    const valence = Math.max(-1, Math.min(1, Number(p?.mood?.valence ?? 0)));
    const energy = Math.max(0, Math.min(1, Number(p?.mood?.energy ?? 0.5)));
    // 正向心情：高兴↑ + 平静↓；负向：悲伤/低落↑ + 平静↓；能量高略微更外放（惊讶/高兴微调）
    const happy = Math.max(0, valence) * 0.7 + energy * 0.1;
    const sad = Math.max(0, -valence) * 0.65;
    const down = Math.max(0, -valence) * 0.3;
    const calm = Math.max(0.15, 1 - happy - sad - down);
    return [happy, 0, sad, 0, 0, down, 0, calm];
  } catch {
    return null;
  }
}
function vectorAlpha() {
  const c = CFG.indextts2 || {};
  return vectorSource === 'state' ? Number(c.stateAlpha ?? 0.9) : Number(c.vectorAlpha ?? 0.7);
}

function presetAlpha(name) {
  const c = CFG.indextts2 || {};
  if (name === '哭腔') return Number(c.cryAlpha ?? 0.95);
  if (['开心', '激动', '惊讶'].includes(name)) return Number(c.emotionAlphaHigh ?? 0.55);
  if (name === '生气') return Number(c.emotionAlphaAngry ?? 0.6);
  if (['伤心', '难过', '哭腔', '委屈'].includes(name)) return Number(c.emotionAlphaSad ?? 0.7);
  return Number(c.emotionAlpha ?? 0.7);
}

function parseVector(value) {
  const parts = String(value)
    .split(/[,，\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  return parts.length === 8 ? parts.map((x) => Math.max(0, x)) : null;
}
let emotion = String(arg('emotion', '') || '');
let vectorSource = 'none';
let emoVector = parseVector(arg('vector', '') || '');
if (emoVector) vectorSource = 'cli';
if (!emoVector && !emotion && (CFG.indextts2?.emotionSource ?? 'state') === 'state') {
  emoVector = stateVector();
}
if (vectorSource === "state" && emoVector && !emotion) emotion = inferEmotionName(emoVector);
if (!emoVector && !emotion && CFG.indextts2?.moodEmotion !== false) {
  emoVector = moodVector();
  if (emoVector) vectorSource = 'mood';
}
let emotionAlpha = Number(arg('emotion-alpha', NaN));
const cryMaxCli = Number(arg('cry-max', NaN));
if (!Number.isFinite(emotionAlpha)) {
  // 命名预设的强度：开心/激动这类容易过火的弱一点
  emotionAlpha = ['开心', '激动', '惊讶'].includes(emotion) ? Number(CFG.indextts2?.emotionAlphaHigh ?? 0.55) : (emotion === '生气' ? Number(CFG.indextts2?.emotionAlphaAngry ?? 0.6) : Number(CFG.indextts2?.emotionAlpha ?? 0.7));
}
if (has('no-emotion')) {
  // 完全不用情绪向量：回到参考音本来的语气（音色最稳）
  emotion = '';
  emoVector = null;
  vectorSource = 'none';
}
if (emotion === '随机') {
  const pool = ['开心', '温柔', '撒娇', '平静', '惊讶'];
  emotion = pool[Math.floor(Math.random() * pool.length)];
}
const jsonOut = has('json');

if (!text) {
  // 列出所有可用音色（合并多个 RVC 包的模型目录）
  if (has('list')) {
    const dirs = [path.join(CFG.rvc.dir, 'assets', 'weights'), ...(CFG.rvc.modelDirs || [])];
    const names = new Set();
    for (const dir of dirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.toLowerCase().endsWith('.pth')) names.add(path.basename(f, path.extname(f)));
        }
      } catch {
        /* 目录不存在就跳过 */
      }
    }
    const list = [...names].sort((a, b) => a.localeCompare(b));
    console.log(`可用音色 ${list.length} 个：`);
    console.log(list.join(', '));
    process.exit(0);
  }
  console.error('缺少 --text（或加 --list 查看音色）');
  process.exit(2);
}
const maxChars = Number(CFG.limits?.maxChars ?? 220);
let finalText = text.length > maxChars ? text.slice(0, maxChars) : text;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-'));
const results = { text: finalText, voice: noRvc ? 'tts-only' : voice, emotion: emotion || null, emoVector: emoVector || (emotion && EMOTION_PRESETS[emotion]) || null, steps: [] };

function runTts(outWav) {
  return runTtsAsync(outWav);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function indexttsCfg() {
  return CFG.indextts2 || {};
}

function cfgSpeed() {
  return Number(CFG.indextts2?.speed ?? 1);
}

/** 确保 IndexTTS2 常驻服务在跑（首次调用会拉起，模型加载约 20~40 秒） */
async function ensureIndexTts2Server(cfg) {
  const port = Number(cfg.port) || 8765;
  const health = `http://127.0.0.1:${port}/health`;
  try {
    const d = await httpJson(health, {}, 2000);
    if (d?.ready) return true;
  } catch {
    /* 服务没起来 */
  }
  const logPath = path.join(LOG_DIR, 'indextts2.log');
  const fd = fs.openSync(logPath, 'a');
  const env = {
    ...process.env,
    INDEXTTS_ROOT: String(cfg.root || path.dirname(String(cfg.python || ''))),
    INDEXTTS_MODEL_DIR: String(cfg.modelDir || ''),
    INDEXTTS_REF: String(cfg.refAudio || ''),
    INDEXTTS_PORT: String(port),
    INDEXTTS_IDLE: String(cfg.idleSeconds ?? 0),
    INDEXTTS_MIN_FREE_MB: String(cfg.minFreeMb ?? 2500),
    INDEXTTS_MIN_COMMIT_MB: String(cfg.minCommitMb ?? 5500),
  };
  const child = spawn(String(cfg.python), [path.join(__dirname, 'indextts2_server.py')], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env,
  });
  child.unref();
  let childExited = false;
  child.once('exit', () => { childExited = true; });
  log(`已拉起 IndexTTS2 服务（pid ${child.pid}），等待模型加载…`);
  const deadline = Date.now() + Number(cfg.startTimeoutMs || 300000);
  while (Date.now() < deadline) {
    await sleep(1500);
    if (childExited) throw new Error('IndexTTS2 服务进程已退出（内存不足或被占用），看 voice/logs/indextts2.log');
    try {
      const d = await httpJson(health, {}, 2000);
      if (d?.ready) return true;
    } catch {
      /* 继续等 */
    }
  }
  throw new Error('IndexTTS2 服务启动超时（看 voice/logs/indextts2.log）');
}

async function synthWithIndexTts2(outWav) {
  const cfg = indexttsCfg();
  if (!cfg.python) throw new Error('未配置 indextts2.python');
  await ensureIndexTts2Server(cfg);
  const port = Number(cfg.port) || 8765;
  // emotionAudio：语气/情绪参考（默认就用同一段参考音，把它的语气一起克隆过来）
  const emotionAudio = cfg.emotionAudio || cfg.refAudio || '';
  const emoAlpha = cfg.emoAlpha ?? 0.7;
  const data = await httpJson(
    `http://127.0.0.1:${port}/synth`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: finalText,
        output: outWav,
        ref: cfg.refAudio || '',
        // 统一走情绪向量：显式向量 > 命名预设解析成向量 > 参考音情绪
        ...(emoVector || (emotion && EMOTION_PRESETS[emotion])
          ? {
              emoVector: emoVector || EMOTION_PRESETS[emotion],
              emoAlpha: Number(emoVector ? vectorAlpha() : presetAlpha(emotion)),
            }
          : { emotionAudio, emoAlpha }),
      }),
    },
    Number(cfg.timeoutMs || 300000),
  );
  if (!data?.ok) throw new Error(data?.error || 'IndexTTS2 合成失败');
  return outWav;
}

// ── 真人化：分句合成 + 换气停顿 + 轻微呼吸声 ──────────────────────────────
function splitClauses(t) {
  // 只在句末标点处切，逗号留在句内（切太碎会不自然）
  const parts = String(t).split(/(?<=[。！？!?…])/);
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (s) out.push(s);
  }
  return out;
}

function probeWav(file) {
  try {
    const ffprobe = path.join(CFG.rvc.dir, 'ffprobe.exe');
    const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
    const st = JSON.parse(out).streams?.[0] || {};
    return { sr: Number(st.sample_rate) || 22050, ch: Number(st.channels) || 1 };
  } catch {
    return { sr: 22050, ch: 1 };
  }
}

function ffmpegCmd(args) {
  const ffmpeg = path.join(CFG.rvc.dir, 'ffmpeg.exe');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true });
}

/** 语速调整：atempo 保持音高，<1 变慢、>1 变快（IndexTTS2 v2 本身没有语速参数，用后处理实现） */
function applyTempo(file, factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || Math.abs(f - 1) < 0.01) return;
  const tmp = `${file}.tempo.wav`;
  ffmpegCmd(['-i', file, '-filter:a', `atempo=${f.toFixed(3)}`, '-c:a', 'pcm_s16le', tmp]);
  fs.renameSync(tmp, file);
}

/** 低中强度伤心：音高逐步下沉 + 音量逐步变小（句尾更明显） */
function applySadContour(file, cry) {
  // 低中强度伤心：Praat PSOLA 只降结尾「音高曲线」（不改共振峰/音色），再叠音量渐弱
  if (process.env.SAD_CONTOUR === '0') return;
  if (!(cry > 0.05) || cry > 0.62) return;
  try {
    const { sr, ch } = probeWav(file);
    const bytes = Math.max(0, fs.statSync(file).size - 44);
    const dur = bytes / (sr * 2 * ch);
    if (!(dur > 1.2)) return;
    const script = path.join(__dirname, 'pitch_contour.py');
    try {
      execFileSync(CFG.rvc.python, [script, file, '0.4', 'auto'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    } catch (e) {
      log('PSOLA 降调失败: ' + (e && e.message ? e.message : e));
    }
    const tmp = file + '.vol.wav';
    const volExpr = '1-0.3*(t/' + dur.toFixed(3) + ')';
    ffmpegCmd([
      '-i', file,
      '-filter:a', "volume='" + volExpr + "':eval=frame,areverse,afade=t=in:st=0:d=0.35,areverse",
      '-ar', String(sr), '-ac', String(ch), '-c:a', 'pcm_s16le', tmp,
    ]);
    fs.renameSync(tmp, file);
  } catch (e) {
    log('applySadContour 失败: ' + (e && e.message ? e.message : e));
  }
}

/** 开心：PSOLA 整段升调（不改音色）+ 稍快 + 稍响 */
const EMOTION_TONE = {
  开心: { st: 1.2, tempo: 1.08, vol: 1.06 },
  撒娇: { st: 0.9, tempo: 0.97, vol: 1.02 },
  温柔: { st: -0.5, tempo: 0.94, vol: 0.95 },
  惊讶: { st: 2.0, tempo: 1.10, vol: 1.08 },
  委屈: { st: 0.3, tempo: 0.97, vol: 0.92 },
};

/** 不同情绪的「语气」：PSOLA 整段升降调（保音色）+ 语速 + 音量 */
function applyEmotionTone(file, emotion, alpha) {
  const prof = EMOTION_TONE[emotion];
  if (!prof || !(alpha > 0.1)) return;
  try {
    const k = Math.min(1, alpha / 0.9);
    const script = path.join(__dirname, 'pitch_contour.py');
    const st = prof.st * k;
    if (Math.abs(st) > 0.05) {
      execFileSync(CFG.rvc.python, [script, file, 'full', st.toFixed(2)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    }
    const { sr, ch } = probeWav(file);
    const tempo = 1 + (prof.tempo - 1) * k;
    const vol = 1 + (prof.vol - 1) * k;
    const tmp = file + '.tone.wav';
    ffmpegCmd(['-i', file, '-filter:a', 'atempo=' + tempo.toFixed(3) + ',volume=' + vol.toFixed(3), '-ar', String(sr), '-ac', String(ch), '-c:a', 'pcm_s16le', tmp]);
    fs.renameSync(tmp, file);
  } catch (e) {
    log('applyEmotionTone 失败: ' + (e && e.message ? e.message : e));
  }
}

/** 情绪 → 声学参数：所有情绪都按 8 维向量连续调制（不是固定预设） */
function emotionParams(vector, alpha, baseSpeed = 1) {
  const speed = Number(baseSpeed) || 1;
  if (!Array.isArray(vector) || vector.length !== 8) return { tempo: speed, pitchSemitones: 0, tremolo: null, sob: false, cry: 0 };
  const a = Number.isFinite(Number(alpha)) ? Number(alpha) : 0.7;
  // 情绪强度：向量 × alpha（只乘一次）
  const v = vector.map((x) => Math.max(0, Number(x) || 0) * a);
  const [happy, angry, sad, afraid, disgust, down, surprised, calm] = v;

  // 悲伤/低落 → 哭感（连续）：0=正常，1=崩溃大哭
  // 阈值/量程可在 config.indextts2.cryThreshold / cryRange 调（阈值越低越容易带哭腔）
  const cryRaw = sad * 0.7 + down * 0.5;
  const cryThreshold = Number(CFG.indextts2?.cryThreshold ?? 0.12);
  const cryRange = Math.max(0.1, Number(CFG.indextts2?.cryRange ?? 0.75));
  const cryMax = Math.max(0.1, Math.min(1, Number(Number.isFinite(cryMaxCli) ? cryMaxCli : (CFG.indextts2?.cryMax ?? 0.9))));
  const cry = Math.max(0, Math.min(cryMax, (cryRaw - cryThreshold) / cryRange));

  // 音高（半音）：开心/惊讶/生气升；悲伤按哭感降
  const pitchSemitones = happy * 1.2 + surprised * 3.0 - angry * 1.2 + afraid * 0.8 - disgust * 0.3 - cry * 1.3;

  // 语速：开心/生气/惊讶偏快，悲伤/低落/温柔偏慢
  const speedFactor = 1 + 0.15 * happy + 0.10 * angry + 0.06 * surprised - 0.07 * (sad + down) - 0.02 * calm;
  const tempo = Math.max(0.8, Math.min(1.15, speed * speedFactor));

  // 颤音：哭感 / 害怕
  let tremolo = null;
  if (cry > 0.12) tremolo = { f: 5.5 + 1.2 * cry, d: cry <= 0.62 ? Math.min(0.2, 0.1 + 0.2 * cry) : 0.15 + 0.4 * cry };
  else if (afraid > 0.18) tremolo = { f: 7, d: 0.12 + 0.2 * Math.min(1, afraid) };

  // 分段语义：>=0.55 带抽噎（快哭出来）；>=0.95 才算「真哭出声」（需显式放开 cryMax）
  const sobThreshold = Number(CFG.indextts2?.sobThreshold ?? 0.55);
  const trueCryThreshold = Number(CFG.indextts2?.trueCryThreshold ?? 0.95);
  return {
    tempo,
    pitchSemitones,
    angry,
    tremolo,
    sob: cry >= sobThreshold,
    trueCry: cry >= trueCryThreshold,
    cry,
  };
}

/** 按 emotionParams 的结果对音频做后处理（音高/语速/颤音/抽噎） */
function applyEmotionProsody(file, params) {
  if (!params) return;
  const { tempo, pitchSemitones, tremolo, sob, cry, trueCry, angry = 0 } = params;
  // 变调会改变共振峰导致音色不像本人，保持禁用；生气靠向量 + 语速 + 音量表达
  const doPitch = false;
  const doTempo = Math.abs(tempo - 1) > 0.01;
  if (doPitch || doTempo || tremolo) {
    const chain = [];
    // 哭腔：音高颤动（wail），不是只有音量起伏
    // 生气时加一点音量（不改音调），让语气更冲
    if (angry >= 0.35) chain.push(`volume=${(1 + 0.2 * Math.min(1, angry)).toFixed(3)}`);
    if (doPitch) {
      const rate = Math.round(22050 * Math.pow(2, pitchSemitones / 12));
      chain.push(`asetrate=${rate}`, 'aresample=22050');
      // asetrate 会改变时长，用 atempo 补偿回来
      chain.push(`atempo=${(1 / Math.pow(2, pitchSemitones / 12)).toFixed(4)}`);
    }
    if (doTempo) chain.push(`atempo=${tempo.toFixed(4)}`);
    if (tremolo) chain.push(`tremolo=f=${tremolo.f.toFixed(1)}:d=${tremolo.d.toFixed(2)}`);
    // 伤心/哭腔整体降一点音量
    if (cry > 0.4) chain.push('volume=0.8');
    // 结尾收一点音量，避免最后一个字/抽噎太冲
    if (cry > 0.4) chain.push('areverse', 'afade=t=in:st=0:d=0.22', 'areverse');
    const tmp = `${file}.prosody.wav`;
    ffmpegCmd(['-i', file, '-af', chain.join(','), '-c:a', 'pcm_s16le', tmp]);
    fs.renameSync(tmp, file);
  }
  if (sob) {
    try {
      const { sr } = probeWav(file);
      const sobFile = path.join(work, 'sob-end.wav');
      // 真哭（>=0.95）抽噎更明显，且补两段（头尾各一次，像真的哭出来）
      makeSob(sr, sobFile, (trueCry ? 0.06 : 0.03) + 0.03 * cry);
      const files = [];
      if (trueCry) files.push(sobFile);
      files.push(file);
      files.push(sobFile);
      if (trueCry) files.push(sobFile);
      const listFile = path.join(work, 'sob-list.txt');
      fs.writeFileSync(
        listFile,
        files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'),
        'utf8',
      );
      const out2 = `${file}.withsob.wav`;
      ffmpegCmd(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', out2]);
      fs.renameSync(out2, file);
    } catch {
      /* 抽噎失败不影响主流程 */
    }
  }
  results.humanized = {
    ...(results.humanized || {}),
    cryStrength: Number((cry || 0).toFixed(2)),
    pitchSemitones: Math.round(pitchSemitones * 100) / 100,
    tempo: Math.round(tempo * 1000) / 1000,
    tremolo: tremolo ? Number(tremolo.d.toFixed(2)) : 0,
    sob: Boolean(sob),
    trueCry: Boolean(trueCry),
  };
}

function makeSilence(sr, ms, out) {
  ffmpegCmd(['-f', 'lavfi', '-i', `anullsrc=r=${sr}:cl=mono`, '-t', String(ms / 1000), '-c:a', 'pcm_s16le', out]);
}

function makeBreath(sr, ms, out, volume = 0.03) {
  const dur = (ms / 1000).toFixed(3);
  const fadeOutStart = Math.max(0.05, ms / 1000 - 0.14).toFixed(2);
  ffmpegCmd([
    '-f', 'lavfi', '-i', `anoisesrc=d=${dur}:c=pink:r=${sr}:a=${volume}`,
    '-af', `highpass=f=350,lowpass=f=4200,afade=t=in:st=0:d=0.10,afade=t=out:st=${fadeOutStart}:d=0.14`,
    '-c:a', 'pcm_s16le', out,
  ]);
}

async function postSynth(text, output, emotion, alphaOverride, vector) {
  const cfg = indexttsCfg();
  const port = Number(cfg.port) || 8765;
  const body = { text, output, ref: cfg.refAudio || '' };
  const vec = Array.isArray(vector) && vector.length === 8 ? vector : emotion && EMOTION_PRESETS[emotion] ? EMOTION_PRESETS[emotion] : null;
  const cryAlpha = Number(alphaOverride ?? cfg.cryAlpha ?? 0.95);
  const cryLevel = vec ? (Math.max(0, Number(vec[2]) || 0) * 0.7 + Math.max(0, Number(vec[5]) || 0) * 0.5) * cryAlpha : 0;
  if (cfg.cryAudioRef && fs.existsSync(cfg.cryAudioRef) && cryLevel >= 0.45) {
    // 真实哭声参考：语气照哭声克隆，音色仍用她的参考音
    body.emotionAudio = cfg.cryAudioRef;
    body.emoAlpha = Number(cfg.cryEmoAlpha ?? 1);
  } else if (vec) {
    body.emoVector = vec;
    body.emoAlpha = Number(alphaOverride ?? (Array.isArray(vector) ? vectorAlpha() : presetAlpha(emotion)) ?? cfg.emotionAlpha ?? 0.7);
  } else if (cfg.emotionAudio || cfg.refAudio) {
    body.emotionAudio = cfg.emotionAudio || cfg.refAudio;
    body.emoAlpha = Number(cfg.emoAlpha ?? 0.7);
  }
  const data = await httpJson(
    `http://127.0.0.1:${port}/synth`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    Number(cfg.timeoutMs || 300000),
  );
  if (!data?.ok) throw new Error(data?.error || 'IndexTTS2 合成失败');
}

/** 哭腔滤镜：升 1 个半音 + 放慢 + 颤音（保持可听细节） */
function applyCryChain(file) {
  const tmp = `${file}.cry.wav`;
  ffmpegCmd(['-i', file, '-af', 'asetrate=23362,aresample=22050,atempo=0.8966,tremolo=f=6.2:d=0.5', '-c:a', 'pcm_s16le', tmp]);
  fs.renameSync(tmp, file);
}

function makeSob(sr, out, volume = 0.045) {
  ffmpegCmd([
    '-f', 'lavfi', '-i', `anoisesrc=d=0.5:c=pink:r=${sr}:a=${volume}`,
    '-af', 'highpass=f=400,lowpass=f=4200,tremolo=f=9.5:d=0.7,afade=t=in:st=0:d=0.10,afade=t=out:st=0.36:d=0.14',
    '-c:a', 'pcm_s16le', out,
  ]);
}

/** 伤心/哭腔专用：逐句合成 → 哭腔滤镜 → 每句之间和首尾插入抽噎 → 拼接 */
async function synthCrying(outWav) {
  const cfg = indexttsCfg();
  const clauses = splitClauses(finalText);
  const segs = clauses.length ? clauses.slice(0, 6) : [finalText];
  if (cfg.cryAudioRef && fs.existsSync(cfg.cryAudioRef)) {
    await postSynth(segs.join('，'), outWav, '难过', Number(cfg.cryAlpha ?? 0.95));
    if (fs.existsSync(outWav) && fs.statSync(outWav).size > 2000) {
      results.humanized = { cry: true, ref: true };
      return outWav;
    }
    return null;
  }
  const sobVolume = Number(cfg.sobVolume ?? 0.045);
  const files = [];
  for (let i = 0; i < segs.length; i++) {
    const out = path.join(work, `cry-${i}.wav`);
    await postSynth(segs[i], out, '难过', Number(cfg.cryAlpha ?? 0.95));
    if (!fs.existsSync(out) || fs.statSync(out).size < 1000) return null;
    applyCryChain(out);
    const faded = path.join(work, `cry-${i}-fade.wav`);
    ffmpegCmd(['-i', out, '-af', 'afade=t=in:st=0:d=0.02,areverse,afade=t=in:st=0:d=0.02,areverse', '-c:a', 'pcm_s16le', faded]);
    files.push(faded);
  }
  const { sr } = probeWav(files[0]);
  const sob = path.join(work, 'sob.wav');
  makeSob(sr, sob, sobVolume);
  const list = [sob];
  for (const f of files) {
    list.push(f);
    list.push(sob);
  }
  const listFile = path.join(work, 'cry-concat.txt');
  fs.writeFileSync(
    listFile,
    list.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  ffmpegCmd(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', '-ar', String(sr), '-ac', '1', outWav]);
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 2000) return null;
  results.humanized = { cry: true, clauses: segs.length, sob: true };
  return outWav;
}

/** 分句合成 + 换气：多子句时返回拼接好的 wav；只有一句时返回 null（走整段合成） */
async function synthHumanized(outWav) {
  const cfg = indexttsCfg();
  // --segment 强制分句 / --no-segment 强制整段（默认看配置，默认整段）
  const segEnabled = has('segment') ? true : has('no-segment') ? false : cfg.segment === true;
  if (!segEnabled) return null;
  const clauses = splitClauses(finalText);
  if (clauses.length < 2) return null;
  const segs = clauses.slice(0, 6); // 最多 6 段，避免太长
  const pauseMs = Number(cfg.pauseMs ?? 150);
  const sentencePauseMs = Number(cfg.sentencePauseMs ?? 320);
  const breathOn = cfg.breath !== false;
  const breathMs = Number(cfg.breathMs ?? 320);
  const breathVolume = Number(cfg.breathVolume ?? 0.03);

  const files = [];
  for (let i = 0; i < segs.length; i++) {
    const out = path.join(work, `seg-${i}.wav`);
    await postSynth(segs[i], out, emotion, emotionAlpha);
    if (!fs.existsSync(out) || fs.statSync(out).size < 1000) return null;
    // 20ms 淡入 + 反向后淡入再反转 = 淡出，消除拼接爆音
    const faded = path.join(work, `seg-${i}-fade.wav`);
    ffmpegCmd(['-i', out, '-af', 'afade=t=in:st=0:d=0.02,areverse,afade=t=in:st=0:d=0.02,areverse', '-c:a', 'pcm_s16le', faded]);
    files.push(faded);
  }
  const { sr } = probeWav(files[0]);
  const silence = path.join(work, 'sil.wav');
  const breath = path.join(work, 'breath.wav');
  let silenceMade = false;
  if (breathOn) makeBreath(sr, breathMs, breath, breathVolume);
  const list = [];
  for (let i = 0; i < files.length; i++) {
    list.push(files[i]);
    const isSentenceEnd = /[。！？!?…]$/.test(segs[i]);
    const hasNext = i < files.length - 1;
    if (!hasNext) break;
    if (isSentenceEnd && breathOn) {
      list.push(breath);
    } else {
      if (!silenceMade) {
        makeSilence(sr, pauseMs, silence);
        silenceMade = true;
      }
      list.push(silence);
    }
  }
  // 句尾停顿：最后一段后补一点呼吸/停顿，避免戛然而止
  if (breathOn) {
    list.push(breath);
  }
  const listFile = path.join(work, 'concat.txt');
  fs.writeFileSync(
    listFile,
    list.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  ffmpegCmd(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', '-ar', String(sr), '-ac', '1', outWav]);
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 2000) return null;
  results.humanized = { clauses: segs.length, breath: breathOn, pauseMs, sentencePauseMs };
  return outWav;
}

async function runTtsAsync(outWav) {
  const txt = path.join(work, 'text.txt');
  fs.writeFileSync(txt, finalText, 'utf8');
  const engine = String(CFG.tts?.engine || 'edge').toLowerCase();
  if (engine === 'indextts2') {
    try {
      const speed = Number(arg('speed', cfgSpeed()));
      const synthVec = emoVector || (emotion && EMOTION_PRESETS[emotion]) || null;
      const cliAlpha = Number(arg('emotion-alpha', NaN));
      const synthAlpha = synthVec
        ? Number(
            Number.isFinite(cliAlpha)
              ? cliAlpha
              : emoVector
                ? vectorAlpha()
                : presetAlpha(emotion),
          )
        : null;
      const humanized = await synthHumanized(outWav);
      if (!humanized) await synthWithIndexTts2(outWav);
      if (fs.existsSync(outWav) && fs.statSync(outWav).size > 1000) {
        // 真实哭声参考已经在模型里带出哭腔，不再叠加颤音/抽噎，避免又变成喘
        const cryLevel = synthVec ? (Math.max(0, Number(synthVec[2]) || 0) * 0.7 + Math.max(0, Number(synthVec[5]) || 0) * 0.5) * Number(synthAlpha ?? 0.95) : 0;
        const usingCryRef = Boolean(CFG.indextts2?.cryAudioRef) && cryLevel >= 0.45;
        if (!usingCryRef) {
          const params = emotionParams(synthVec, synthAlpha, speed);
          applyEmotionProsody(outWav, params);
          applySadContour(outWav, params.cry);
          applyEmotionTone(outWav, emotion, Number(synthAlpha ?? 0.7));
        }
        return { wav: outWav, engine: 'indextts2' };
      }
      log('IndexTTS2 输出为空，回退');
    } catch (error) {
      log(`IndexTTS2 失败: ${String(error.message || error).slice(0, 300)}`);
      results.indexTtsFailed = true;
      // 不允许回退（默认）：宁可不发语音，也不发机械音/错音色
      if (CFG.tts?.fallbackEnabled === false) throw error;
    }
  }
  const allowFallbackTts = engine !== 'indextts2' || CFG.tts?.fallbackEnabled !== false;
  if (allowFallbackTts && (engine === 'edge' || engine === 'indextts2')) {
    try {
      const py = CFG.rvc.python;
      const script = path.join(__dirname, 'tts_edge.py');
      const ffmpeg = path.join(CFG.rvc.dir, 'ffmpeg.exe');
      const args = [
        script,
        '--text-file', txt,
        '--out', outWav,
        '--voice', String(CFG.tts?.edgeVoice || 'zh-CN-XiaoyiNeural'),
        '--rate', String(CFG.tts?.edgeRate || '+0%'),
        '--volume', String(CFG.tts?.edgeVolume || '+0%'),
        '--ffmpeg', fs.existsSync(ffmpeg) ? ffmpeg : 'ffmpeg',
      ];
      execFileSync(py, args, { encoding: 'utf8', timeout: 120000, windowsHide: true });
      if (fs.existsSync(outWav) && fs.statSync(outWav).size > 1000) return { wav: outWav, engine: 'edge' };
      log('edge-tts 输出为空，回退 SAPI');
    } catch (error) {
      log(`edge-tts 失败，回退 SAPI: ${String(error.message || error).slice(0, 200)}`);
    }
  }
  const ps1 = path.join(__dirname, 'tts.ps1');
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-TextFile', txt, '-Out', outWav,
    '-Voice', String(CFG.tts?.voice || 'Microsoft Huihui Desktop'),
    '-Rate', String(CFG.tts?.rate ?? 0),
    '-Volume', String(CFG.tts?.volume ?? 100),
  ];
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 1000) throw new Error('TTS 未生成有效音频: ' + out);
  return { wav: outWav, engine: 'sapi' };
}

function runRvc(inWav, outWav) {
  const py = CFG.rvc.python;
  const script = path.join(__dirname, CFG.rvc.convertScript || 'rvc_convert.py');
  const args = [
    script,
    '--rvc-dir', CFG.rvc.dir,
    '--model-dirs', (CFG.rvc.modelDirs || []).join(';'),
    '--extra-roots', (CFG.rvc.extraRoots || []).join(';'),
    '--input', inWav,
    '--output', outWav,
    '--model', voice,
    '--pitch', String(pitch),
    '--f0-method', String(CFG.rvc.f0Method || 'rmvpe'),
    '--index-rate', String(CFG.rvc.indexRate ?? 0.75),
  ];
  const out = execFileSync(py, args, { encoding: 'utf8', timeout: 180000, windowsHide: true, cwd: CFG.rvc.dir });
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 1000) throw new Error('RVC 未生成有效音频: ' + out);
  return outWav;
}

function bridgeConfig() {
  const p = path.resolve(__dirname, CFG.send.bridgeConfig || '..\\qq-bridge\\config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── 语音记录：她自己发过的语音内容（被问到时能想起来） ────────────────────
const VOICE_HISTORY_FILE = path.join(__dirname, 'logs', 'voice-history.json');

async function recordVoiceHistory(text, key, messageId, bytes) {
  try {
    fs.mkdirSync(path.dirname(VOICE_HISTORY_FILE), { recursive: true });
    let list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(VOICE_HISTORY_FILE, 'utf8'));
      if (Array.isArray(raw)) list = raw;
    } catch {
      /* 第一次写 */
    }
    list.push({
      at: Date.now(),
      key: String(key || ''),
      text: String(text || '').slice(0, 500),
      messageId: messageId ?? null,
      bytes: Number(bytes) || 0,
    });
    fs.writeFileSync(VOICE_HISTORY_FILE, JSON.stringify(list.slice(-300), null, 2), 'utf8');

    // 同时写进记忆库（被问「你刚才语音说的啥」时能回忆）
    try {
      const { pathToFileURL } = await import('node:url');
      const datadirUrl = pathToFileURL(path.join(__dirname, '..', 'dsh-memory', 'src', 'datadir.mjs')).href;
      const memoryUrl = pathToFileURL(path.join(__dirname, '..', 'dsh-memory', 'src', 'index.mjs')).href;
      const { resolveDataDir } = await import(datadirUrl);
      const { HumanMemory } = await import(memoryUrl);
      const memory = new HumanMemory({ dir: resolveDataDir() });
      const when = new Date();
      const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      memory.remember({
        kind: 'semantic',
        text: `[语音] ${stamp} 我在 ${key} 发过一条语音，说的是：「${String(text).slice(0, 300)}」`,
        importance: 0.45,
        tags: ['语音', 'voice', '自述'],
        source: { chat: String(key || ''), messageId: String(messageId ?? ''), ts: Date.now() },
      });
      memory.store?.close?.();
    } catch {
      /* 记忆写入失败不影响发送 */
    }
  } catch {
    /* 记录失败不影响主流程 */
  }
}

async function sendViaBridge(audioFile) {
  const cfg = bridgeConfig();
  const audioDir = path.resolve(__dirname, CFG.send.audioDir || '..\\qq-bridge\\audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const name = `say-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`;
  const target = path.join(audioDir, name);
  fs.copyFileSync(audioFile, target);
  // 控制台鉴权：桥接控制台接口要求带 x-console-token（与 MCP 的 agentApi 一致），
  // 同时带 x-agent-token 让它走 AI 通道做会话校验。
  let consoleToken = '';
  try {
    consoleToken = fs.readFileSync(path.resolve(__dirname, '..', 'qq-bridge', 'state', 'console-token'), 'utf8').trim();
  } catch {
    /* 没有控制台令牌时仅带 agent token，桥接会按 AI 通道判定 */
  }
  const base = CFG.send.bridgeBase || `http://127.0.0.1:${cfg.consolePort || cfg.port || 3100}`;
  const res = await fetch(`${base}/api/socialV2/send-voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': String(token || ''), 'x-console-token': consoleToken },
    body: JSON.stringify({ key: String(key), token: String(token || ''), voice: name, readback: false }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) {
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    throw new Error(data.error || `send-voice 失败 HTTP ${res.status}`);
  }
  return data;
}

async function sendDirect(audioFile) {
  const cfg = bridgeConfig();
  const sl = cfg.snowluma || {};
  const base = sl.httpUrl || 'http://127.0.0.1:3000';
  const m = /^(group|private):(\d+)$/.exec(String(key || ''));
  if (!m) throw new Error('--direct 需要 --key group:群号 / private:QQ号');
  const fileUri = 'file:///' + audioFile.replace(/\\/g, '/');
  const payload = m[1] === 'group'
    ? { group_id: Number(m[2]), message: [{ type: 'record', data: { file: fileUri } }] }
    : { user_id: Number(m[2]), message: [{ type: 'record', data: { file: fileUri } }] };
  const endpoint = m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
  const res = await fetch(`${base}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sl.accessToken}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ status: 'error', retcode: res.status }));
  if (data.status !== 'ok' || data.retcode !== 0) throw new Error(`SnowLuma 发送失败: ${JSON.stringify(data)}`);
  return data;
}

try {
  const ttsWav = path.join(work, 'tts.wav');
  const ttsResult = await runTtsAsync(ttsWav);
  results.steps.push({ step: 'tts', ok: true, engine: ttsResult.engine, bytes: fs.statSync(ttsWav).size });

  let finalWav = ttsWav;
  // IndexTTS2 已经直接克隆目标音色，再做 RVC 会覆盖掉它的语气/音色，默认跳过；
  // IndexTTS2 失败回退到 edge/sapi 时也跳过 RVC（此时系统通常内存/显存紧张，跑 RVC 只会二次失败）
  const ttsEngineForRvc = (results.steps.find((s) => s.step === 'tts') || {}).engine;
  const fallbackOnly = results.indexTtsFailed === true;
  const rvcEnabled = CFG.rvc?.enabled === true;
  const shouldRvc = rvcEnabled && !noRvc && !(ttsEngineForRvc === 'indextts2' && !has('force-rvc')) && !fallbackOnly;
  if (!shouldRvc && !noRvc) {
    const reason = !rvcEnabled
      ? 'RVC 已禁用（config.rvc.enabled=false）'
      : (fallbackOnly ? 'IndexTTS2 失败回退，跳过 RVC（--force-rvc 可强制）' : 'IndexTTS2 已克隆音色，跳过 RVC（--force-rvc 可强制）');
    results.steps.push({ step: 'rvc', ok: true, skipped: true, reason });
  }
  if (shouldRvc) {
    try {
      const rvcWav = path.join(work, 'rvc.wav');
      runRvc(ttsWav, rvcWav);
      finalWav = rvcWav;
      results.steps.push({ step: 'rvc', ok: true, bytes: fs.statSync(rvcWav).size, model: voice });
    } catch (error) {
      results.steps.push({ step: 'rvc', ok: false, error: String(error.message || error).slice(0, 300) });
      if (!has('fallback-ok')) throw error;
      log(`RVC 失败，回退 TTS 原声: ${error.message}`);
    }
  }
  results.audio = finalWav;
  results.audioBytes = fs.statSync(finalWav).size;

  if (!dry) {
    if (!key) throw new Error('缺少 --key（或加 --dry 只生成）');
    let sent;
    if (direct) {
      sent = await sendDirect(finalWav);
    } else {
      if (!token) throw new Error('发桥接必须带 --token（agent token）；测试可用 --direct');
      sent = await sendViaBridge(finalWav);
    }
    results.sent = { ok: true, messageId: sent.messageId ?? sent.data?.message_id ?? null };
    await recordVoiceHistory(finalText, key, results.sent.messageId, results.audioBytes);
    results.steps.push({ step: 'send', ok: true, mode: direct ? 'direct' : 'bridge' });
  } else {
    results.steps.push({ step: 'send', ok: true, skipped: true });
  }

  log(JSON.stringify(results));
  if (jsonOut) {
    console.log(JSON.stringify(results));
  } else {
    console.log(`文本: ${finalText}`);
    console.log(`语音: ${results.audio}（${results.audioBytes} bytes）`);
    for (const s of results.steps) console.log(`- ${s.step}: ${s.ok ? 'ok' : '失败'} ${s.error || ''}`);
    if (results.sent) console.log(`发送成功 messageId=${results.sent.messageId}`);
  }
  process.exit(0);
} catch (error) {
  results.error = String(error.message || error);
  log(JSON.stringify(results));
  if (jsonOut) console.log(JSON.stringify(results));
  else console.error('失败: ' + results.error);
  process.exit(1);
} finally {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
