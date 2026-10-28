// dsh-voice：本地语音（IndexTTS2）+ 情绪推演 插件（Host 半）
//
// 提供服务级工具（agent 可直接调用）：
//   voice_say              合成一句话并发到 QQ（或只合成）；支持情绪名 / 8 维情绪向量
//   voice_send_file        把已有音频文件发到 QQ
//   voice_health           看语音服务是否就绪；未就绪且允许时自动拉起
//   voice_emotion_state    查看当前情绪状态（情绪推演模块维护）
//   voice_emotion_simulate 给一段话做情绪推演（推断对方 + 我的情绪变化 + 建议语气）
//   voice_emotion_tick     只推进情绪时间（回落 + 昼夜节律）
//
// 运行时文件在 ../runtime/：indextts2_server.py、emotion.mjs、datadir.mjs
// 配置：bundle 的 cordis.patch.yml 里的 row config（用户 patch 层可覆盖），或 runtime/config.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEmotionState, simulate, tick } from '../runtime/emotion.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(here, '..', 'runtime');
const LOG_DIR = path.join(RUNTIME, 'logs');

export const name = 'dsh-voice';
export const inject = ['tools'];

const DEFAULTS = {
  indextts2: {
    // 首次使用必须配置：python（IndexTTS2 venv 的 python）、root、modelDir、refAudio
    python: 'python',
    root: '',
    modelDir: '',
    refAudio: '',
    port: 8765,
    autoStart: true,
    startTimeoutMs: 300000,
    timeoutMs: 300000,
    idleSeconds: 0,
    minFreeMb: 2500,
    minCommitMb: 5500,
  },
  qq: {
    baseUrl: 'http://127.0.0.1:3000',
    token: '',
    timeoutMs: 60000,
  },
  voice: {
    vectorAlpha: 0.7,
    stateAlpha: 0.9,
  },
  memoryDir: '',
};

// 情绪向量顺序 [高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
const EMOTION_PRESETS = {
  开心: [0.55, 0, 0, 0, 0, 0, 0, 0.45],
  激动: [0.50, 0, 0, 0, 0, 0, 0.20, 0.30],
  温柔: [0.30, 0, 0, 0, 0, 0, 0, 0.70],
  撒娇: [0.35, 0, 0, 0, 0, 0, 0, 0.65],
  生气: [0, 0.85, 0, 0, 0, 0, 0, 0.15],
  委屈: [0, 0, 0.25, 0, 0, 0.60, 0, 0.15],
  难过: [0, 0, 0.70, 0, 0, 0.25, 0, 0.05],
  伤心: [0, 0, 0.60, 0, 0, 0.35, 0, 0.05],
  哭腔: [0, 0, 0.85, 0, 0, 0.45, 0, 0.05],
  惊讶: [0.15, 0, 0, 0, 0, 0, 0.60, 0.25],
  平静: [0, 0, 0, 0, 0, 0, 0, 1.0],
};

function isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function mergeConfig(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObject(base[k]) && isObject(v) ? mergeConfig(base[k], v) : v;
  }
  return out;
}

/** 行配置 + runtime/config.json 合成最终配置 */
export function resolveConfig(rowConfig) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'config.json'), 'utf8'));
  } catch {
    /* 没有本地配置就用 row config / 默认值 */
  }
  return mergeConfig(mergeConfig(DEFAULTS, fileCfg), rowConfig || {});
}

function memoryDirOf(cfg) {
  if (cfg.memoryDir) return cfg.memoryDir;
  if (process.env.MEMORY_DIR) return process.env.MEMORY_DIR;
  return path.join(os.homedir(), '.dsh', 'qq-memory');
}

async function httpJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(text).slice(0, 300)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function serverHealth(port) {
  try {
    return await httpJson(`http://127.0.0.1:${port}/health`, {}, 2000);
  } catch {
    return null;
  }
}

function spawnVoiceServer(cfg, reason) {
  const ix = cfg.indextts2;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'indextts2.log');
  const fd = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    INDEXTTS_ROOT: String(ix.root || ''),
    INDEXTTS_MODEL_DIR: String(ix.modelDir || ''),
    INDEXTTS_REF: String(ix.refAudio || ''),
    INDEXTTS_PORT: String(ix.port || 8765),
    INDEXTTS_IDLE: String(ix.idleSeconds ?? 0),
    INDEXTTS_MIN_FREE_MB: String(ix.minFreeMb ?? 2500),
    INDEXTTS_MIN_COMMIT_MB: String(ix.minCommitMb ?? 5500),
  };
  const child = spawn(String(ix.python), [path.join(RUNTIME, 'indextts2_server.py')], {
    cwd: RUNTIME,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env,
  });
  child.unref();
  console.log(`[dsh-voice] 启动语音服务（${reason}，pid ${child.pid}）`);
  return child;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 确保语音服务就绪；允许时自动拉起并等待模型加载 */
async function ensureServer(cfg) {
  const port = Number(cfg.indextts2.port) || 8765;
  const health = await serverHealth(port);
  if (health?.ready) return { ready: true, started: false, health };
  // 首次使用必须先在插件配置里填好 IndexTTS2 路径
  const missing = ['python', 'root', 'modelDir', 'refAudio'].filter((k) => !String(cfg.indextts2[k] || '').trim() || String(cfg.indextts2[k]).trim() === 'python');
  if (missing.length) {
    return {
      ready: false,
      started: false,
      health,
      error: `还没配置 IndexTTS2：请在插件 voice 行的 config 里填写 indextts2.${missing.join(' / indextts2.')}（python/root/modelDir/refAudio）`,
    };
  }
  if (cfg.indextts2.autoStart === false) {
    return { ready: false, started: false, health, error: `语音服务未就绪（127.0.0.1:${port}），且 autoStart=false` };
  }
  spawnVoiceServer(cfg, 'voice_health/voice_say 自动拉起');
  const deadline = Date.now() + (Number(cfg.indextts2.startTimeoutMs) || 300000);
  while (Date.now() < deadline) {
    await sleep(1500);
    const h = await serverHealth(port);
    if (h?.ready) return { ready: true, started: true, health: h };
  }
  return { ready: false, started: true, health: null, error: '等待模型加载超时，看 runtime/logs/indextts2.log' };
}

function vectorFor(cfg, args) {
  const vec = Array.isArray(args.emoVector) && args.emoVector.length === 8
    ? args.emoVector.map((x) => Math.max(0, Number(x) || 0))
    : null;
  if (vec) return { vector: vec, alpha: Number(cfg.voice.vectorAlpha ?? 0.7), source: 'explicit' };
  const emotion = String(args.emotion || '').trim();
  if (emotion && EMOTION_PRESETS[emotion]) {
    return { vector: EMOTION_PRESETS[emotion], alpha: emotion === '哭腔' ? 0.95 : Number(cfg.voice.vectorAlpha ?? 0.7), source: `preset:${emotion}` };
  }
  try {
    const state = loadEmotionState({ memoryDir: memoryDirOf(cfg) });
    const v = state?.self?.vector;
    if (Array.isArray(v) && v.length === 8 && v.some((x) => x > 0)) {
      return { vector: v.map((x) => Math.max(0, Number(x) || 0)), alpha: Number(cfg.voice.stateAlpha ?? 0.9), source: 'emotion-state' };
    }
  } catch {
    /* 没有状态 */
  }
  return { vector: null, alpha: 0, source: 'none' };
}

async function synthesize(cfg, text, vectorInfo) {
  const port = Number(cfg.indextts2.port) || 8765;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-'));
  const outWav = path.join(outDir, 'voice.wav');
  const body = { text, output: outWav, ref: String(cfg.indextts2.refAudio || '') };
  if (vectorInfo.vector) {
    body.emoVector = vectorInfo.vector;
    body.emoAlpha = vectorInfo.alpha;
  }
  const data = await httpJson(
    `http://127.0.0.1:${port}/synth`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    Number(cfg.indextts2.timeoutMs) || 300000,
  );
  if (!data?.ok || !fs.existsSync(outWav)) throw new Error(data?.error || '合成失败，没有生成音频');
  return { outWav, bytes: fs.statSync(outWav).size };
}

function parseTarget(key) {
  const m = /^(private|group):(\d+)$/.exec(String(key || '').trim());
  if (!m) throw new Error('key 需要形如 private:2311464997 或 group:123456');
  return { kind: m[1], id: Number(m[2]) };
}

async function sendQQ(cfg, key, wavPath) {
  const target = parseTarget(key);
  const token = String(cfg.qq.token || '').trim();
  if (!token) throw new Error('未配置 qq.token（SnowLuma/OneBot 的 access token），无法发送到 QQ');
  const endpoint = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const fileUri = 'file:///' + path.resolve(wavPath).replace(/\\/g, '/');
  const body = target.kind === 'group'
    ? { group_id: target.id, message: [{ type: 'record', data: { file: fileUri } }] }
    : { user_id: target.id, message: [{ type: 'record', data: { file: fileUri } }] };
  const data = await httpJson(
    `${String(cfg.qq.baseUrl).replace(/\/+$/, '')}/${endpoint}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    Number(cfg.qq.timeoutMs) || 60000,
  );
  const messageId = data?.data?.message_id ?? data?.message_id ?? data?.data?.messageId ?? null;
  if (data?.status && data.status !== 'ok') throw new Error(`发送失败：${JSON.stringify(data).slice(0, 300)}`);
  return { messageId };
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
  },
};

function textResult(value, summary) {
  return [{ type: 'text', text: summary || JSON.stringify(value) }];
}

function tool(name, description, parameters, execute, renderSummary) {
  return {
    name,
    description,
    parameters,
    timeoutMs: 900000,
    output: {
      schema: outputSchema,
      render(_args, value) {
        return textResult(value, renderSummary ? renderSummary(value) : undefined);
      },
    },
    execute,
  };
}

export function apply(ctx, rowConfig) {
  const cfg = resolveConfig(rowConfig);
  ctx.logger?.info?.('[dsh-voice] 已加载，runtime=%s', RUNTIME);

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(tool(
        'voice_say',
        '用本地 IndexTTS2 合成一句中文语音。可选：emotion 情绪名（开心/温柔/撒娇/生气/委屈/难过/伤心/哭腔/惊讶/平静）、emoVector 8 维情绪向量 [高兴,愤怒,悲伤,恐惧,反感,低落,惊讶,平静]、key 发送目标（private:<QQ号> / group:<群号>，不填只合成不发送）。默认会参考当前情绪推演状态决定语气。',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要说的中文内容（1~2 句，尽量口语）' },
            key: { type: 'string', description: '发送目标，如 private:2311464997 或 group:123456；省略则只返回音频路径' },
            emotion: { type: 'string', description: '情绪名（可选）：开心/激动/温柔/撒娇/生气/委屈/难过/伤心/哭腔/惊讶/平静' },
            emoVector: {
              type: 'array',
              items: { type: 'number' },
              description: '8 维情绪向量（可选，优先于 emotion）：[高兴,愤怒,悲伤,恐惧,反感,低落,惊讶,平静]，每个 0~1',
            },
          },
          required: ['text'],
        },
        async (args) => {
          const text = String(args.text || '').trim();
          if (!text) throw new Error('text 不能为空');
          const server = await ensureServer(cfg);
          if (!server.ready) throw new Error(server.error || '语音服务不可用');
          const vectorInfo = vectorFor(cfg, args);
          const synth = await synthesize(cfg, text, vectorInfo);
          const result = { ok: true, audio: synth.outWav, bytes: synth.bytes, emotionSource: vectorInfo.source };
          if (args.key) Object.assign(result, await sendQQ(cfg, args.key, synth.outWav));
          return result;
        },
        (value) => (value.messageId
          ? `已发送语音（messageId ${value.messageId}，${value.bytes} 字节，情绪来源 ${value.emotionSource}）`
          : `已合成语音：${value.audio}（${value.bytes} 字节，情绪来源 ${value.emotionSource}）`),
      )),

      ctx.tools.register(tool(
        'voice_send_file',
        '把一个已有的音频文件（wav/mp3）发送到 QQ 私聊或群。参数：path 音频路径，key 形如 private:<QQ号> 或 group:<群号>。',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '本地音频文件路径' },
            key: { type: 'string', description: '发送目标：private:<QQ号> 或 group:<群号>' },
          },
          required: ['path', 'key'],
        },
        async (args) => {
          const file = String(args.path || '');
          if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
          const sent = await sendQQ(cfg, args.key, file);
          return { ok: true, audio: file, messageId: sent.messageId };
        },
        (value) => `已发送音频（messageId ${value.messageId}）`,
      )),

      ctx.tools.register(tool(
        'voice_health',
        '检查本地语音服务（IndexTTS2）是否就绪；未就绪时按配置自动拉起并等待模型加载。返回 ready、端口、地址和启动信息。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const server = await ensureServer(cfg);
          return {
            ok: server.ready,
            ready: server.ready,
            started: server.started,
            port: Number(cfg.indextts2.port) || 8765,
            url: `http://127.0.0.1:${Number(cfg.indextts2.port) || 8765}/health`,
            health: server.health,
            error: server.error || null,
            runtime: RUNTIME,
          };
        },
        (value) => (value.ready ? `语音服务就绪（127.0.0.1:${value.port}${value.started ? '，刚拉起' : ''}）` : `语音服务未就绪：${value.error || '未知原因'}`),
      )),

      ctx.tools.register(tool(
        'voice_emotion_state',
        '查看当前情绪状态（情绪推演模块维护的 emotion-state.json）：我此刻的情绪向量/最近一次互动/关系亲密度。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const state = loadEmotionState({ memoryDir: memoryDirOf(cfg) });
          const history = Array.isArray(state.history) ? state.history : [];
          const relations = Object.entries(state.relations || {})
            .sort((a, b) => (b[1].affinity || 0) - (a[1].affinity || 0))
            .slice(0, 5)
            .map(([qq, r]) => ({ qq, affinity: Math.round((r.affinity || 0) * 100) / 100, interactions: r.interactions }));
          return {
            ok: true,
            memoryDir: memoryDirOf(cfg),
            self: state.self,
            lastInteraction: history.length ? history[history.length - 1] : null,
            relations,
          };
        },
        (value) => `当前情绪向量：${(value.self?.vector || []).map((x) => Math.round(x * 100) / 100).join(', ')}`,
      )),

      ctx.tools.register(tool(
        'voice_emotion_simulate',
        '情绪推演：给一段对方说的话，推断对方情绪 + 按评价理论推演我自己的情绪变化（有惯性、负面回落更慢、昼夜节律），返回推演叙述和建议的语音语气。',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '对方说的话（最近一条或几条拼起来）' },
            sender: { type: 'string', description: '对方 QQ/昵称（可选，用于关系亲密度）' },
            affinity: { type: 'number', description: '关系亲密度 0~1（可选）' },
          },
          required: ['text'],
        },
        async (args) => {
          const result = simulate({
            memoryDir: memoryDirOf(cfg),
            text: String(args.text || ''),
            sender: args.sender ? String(args.sender) : '',
            affinity: Number.isFinite(Number(args.affinity)) ? Number(args.affinity) : undefined,
          });
          return { ok: true, ...result };
        },
        (value) => value.narrative || '情绪推演完成',
      )),

      ctx.tools.register(tool(
        'voice_emotion_tick',
        '只推进情绪时间（不处理新消息）：让情绪向基线回落并应用昼夜节律，适合定时调用。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const result = tick({ memoryDir: memoryDirOf(cfg) });
          return { ok: true, ...result };
        },
        (value) => `情绪已回落：${value.self?.label || '平静'} ${value.self?.intensity ?? ''}`,
      )),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 忽略卸载错误 */
        }
      }
    };
  });
}
