// 情绪推演模块：不是「一条消息套一个情绪」，而是模拟正常人的情绪动态
//
// 三层：
//   瞬间情绪（事件评价 → 情绪增量，秒~分钟）
//   心境（慢变量，小时~天；有惯性、有回落、有昼夜节律）
//   关系（对不同人的情绪反应强度不同）
//
// 推演流程（simulate）：
//   1. inferUserEmotion：从对方的话里推断他现在的情绪（词表 + 语气特征）
//   2. appraise：这件事对我意味着什么（夸奖/被凶/被撒娇/被敷衍…，按关系亲疏放大或减弱）
//   3. updateSelf：瞬时情绪 = 惯性保持 + 新评价推动；心情向基线回落（负面回得慢）
//   4. 输出：对方情绪、我的情绪、自然语言推演、建议的语音语气参数
//
// 状态文件：~/.dsh/qq-memory/emotion-state.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './datadir.mjs';

const SCHEMA = 1;
// 8 维情绪向量 [高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
const BASELINE = [0.12, 0, 0.03, 0, 0, 0.02, 0, 0.78]; // 基线：略正向、平静
const EMO_LABELS = ['高兴', '愤怒', '悲伤', '恐惧', '反感', '低落', '惊讶', '平静'];
const LEX = {
  pos: ['谢谢', '喜欢', '爱你', '好棒', '厉害', '可爱', '开心', '高兴', '哈哈', '嘿嘿', '太好了', '舒服', '满意', '爱了'],
  neg: ['烦', '讨厌', '滚', '闭嘴', '傻', '笨', '垃圾', '气死', '恶心', '无语', 'md', '操', '失望', '难过', '伤心', '累', '烦死'],
  highArousal: ['！', '!', '？？', '！！', '啊啊', '卧槽', '天哪', '真的假的', '居然'],
  lowArousal: ['嗯', '哦', '随便', '都行', '算了', '没事', '行吧'],
  tired: ['累', '疲惫', '困', '没力气', '不想', '没劲', '心累', '撑不住'],
  warm: ['乖', '宝贝', '抱抱', '摸摸', '亲亲', '陪你', '我在', '别怕', '晚安'],
  ask: ['?', '？', '吗', '怎么', '为什么', '啥', '什么', '哪', '多少', '能不能', '可不可以'],
};

function stateFile(memoryDir) {
  return path.join(memoryDir || resolveDataDir(), 'emotion-state.json');
}

function defaultState(now) {
  return {
    version: SCHEMA,
    self: { vector: [...BASELINE], updatedAt: now },
    relations: {},
    history: [],
  };
}

export function loadEmotionState({ memoryDir, now = Date.now() } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(memoryDir), 'utf8'));
    if (raw && raw.version === SCHEMA) {
      if (!Array.isArray(raw.self?.vector) || raw.self.vector.length !== 8) raw.self = defaultState(now).self;
      return { ...defaultState(now), ...raw };
    }
  } catch {
    /* 空状态 */
  }
  return defaultState(now);
}

export function saveEmotionState(state, { memoryDir } = {}) {
  const file = stateFile(memoryDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function countMatches(text, words) {
  let n = 0;
  for (const w of words) if (text.includes(w)) n += 1;
  return n;
}

/** 推断对方的情绪（从文字） */
export function inferUserEmotion(text) {
  const t = String(text || '');
  const pos = countMatches(t, LEX.pos);
  const neg = countMatches(t, LEX.neg);
  const high = countMatches(t, LEX.highArousal);
  const low = countMatches(t, LEX.lowArousal);
  const warm = countMatches(t, LEX.warm);
  const ask = countMatches(t, LEX.ask);
  const tired = countMatches(t, LEX.tired);
  const lenFactor = Math.min(1, t.length / 40);

  const valence = clamp01((pos + warm * 0.5 - neg) * 0.25 + 0.5);
  const arousal = clamp01(0.35 + high * 0.18 + (/\?\?|!!/.test(t) ? 0.15 : 0) + lenFactor * 0.2 - low * 0.15);
  let label = '平静';
  if (neg >= 2 && high >= 1) label = '烦躁/生气';
  else if (tired >= 1) label = '疲惫/低落';
  else if (neg >= 1 && low >= 1) label = '低落/失落';
  else if (neg >= 2) label = '不开心';
  else if (pos >= 2 || warm >= 2) label = '开心/亲近';
  else if (ask >= 2) label = '好奇/在问事';
  else if (pos >= 1) label = '心情不错';
  else if (low >= 1) label = '有点冷淡/敷衍';
  return { valence: Math.round(valence * 100) / 100, arousal: Math.round(arousal * 100) / 100, label, pos, neg, warm, ask, tired };
}

/** 评价：这件事对我（她）意味着什么 → 情绪增量（8 维，未乘关系系数） */
export function appraise(text, { affinity = 0.5 } = {}) {
  const t = String(text || '');
  const pos = countMatches(t, LEX.pos);
  const neg = countMatches(t, LEX.neg);
  const warm = countMatches(t, LEX.warm);
  const ask = countMatches(t, LEX.ask);
  const high = countMatches(t, LEX.highArousal);
  const closeness = 0.4 + 0.6 * clamp01(affinity); // 关系越近，情绪反应越强
  const d = [0, 0, 0, 0, 0, 0, 0, 0];
  if (pos || warm) {
    d[0] += (pos * 0.2 + warm * 0.25) * closeness;
    d[7] += 0.1 * closeness;
  }
  if (neg) {
    d[1] += neg * 0.15 * closeness;
    d[2] += neg * 0.12 * closeness;
    d[5] += neg * 0.1 * closeness;
    d[7] -= 0.1;
  }
  if (ask) {
    d[6] += Math.min(0.25, ask * 0.06) * closeness;
    d[7] += 0.05;
  }
  if (high) {
    d[6] += high * 0.05;
    d[0] += high * 0.05;
  }
  return d.map((x) => Math.max(-0.5, Math.min(0.5, x)));
}

/** 昼夜节律：深夜精力低、更脆；下午偏高 */
function circadianFactor(hour) {
  if (hour >= 0 && hour < 6) return 0.7;
  if (hour >= 6 && hour < 9) return 0.85;
  if (hour >= 9 && hour < 12) return 1.0;
  if (hour >= 12 && hour < 18) return 1.05;
  if (hour >= 18 && hour < 21) return 1.0;
  return 0.9;
}

function labelOf(vector) {
  // 按「相对基线的偏移」找主导情绪：平静是基线，不该永远压过真实情绪
  let maxDev = 0;
  let idx = 7;
  for (let i = 0; i < vector.length; i++) {
    const dev = (vector[i] || 0) - BASELINE[i];
    if (dev > maxDev) {
      maxDev = dev;
      idx = i;
    }
  }
  if (maxDev < 0.06) return { label: '平静', intensity: 0.1 };
  const strength = Math.max(0, Math.min(1, (maxDev - 0.06) / 0.45));
  return { label: EMO_LABELS[idx], intensity: Math.round(strength * 100) / 100 };
}

/** 时间衰减：向基线回落（负面情绪回落更慢） */
export function decay(vector, elapsedMs, hour) {
  const hours = Math.max(0, elapsedMs / 3600000);
  const out = vector.map((v, i) => {
    const base = BASELINE[i];
    // 负面维度（愤怒/悲伤/低落）tau 更长；正向 tau 短
    const tau = i === 1 || i === 2 || i === 5 ? 3 : 1.2; // 小时
    const k = Math.exp(-hours / tau);
    return base + (v - base) * k;
  });
  const cf = circadianFactor(hour);
  // 深夜：正向下压、低落上抬（人更脆弱）
  if (cf < 0.8) {
    out[0] *= 0.85;
    out[5] = Math.min(1, out[5] + 0.05);
    out[7] = Math.min(1, out[7] + 0.05);
  }
  return out.map((x) => clamp01(x));
}

/** 核心推演：对方说了什么 → 他什么情绪 → 我怎么评价 → 我情绪怎么变 → 语气建议 */
export function simulate({ text = '', messages = [], sender = '', affinity = 0.5, memoryDir, now = Date.now() } = {}) {
  const state = loadEmotionState({ memoryDir, now });
  const hour = new Date(now).getHours();
  const elapsed = Math.max(0, now - (state.self.updatedAt || now));
  let self = decay(state.self.vector, elapsed, hour);

  const allText = [text, ...(Array.isArray(messages) ? messages : [])].filter(Boolean).join(' ');
  const user = inferUserEmotion(allText);
  const delta = appraise(allText, { affinity });
  const inertia = 0.7; // 情绪惯性：新评价只推动 30%
  const moved = self.map((v, i) => v + (1 - inertia) * delta[i] * 1.6); // 评价幅度放大一点
  // 单次变化限幅 0.25，避免跳变
  self = moved.map((v, i) => {
    const diff = v - self[i];
    return clamp01(self[i] + Math.max(-0.25, Math.min(0.25, diff)));
  });

  const selfLabel = labelOf(self);
  const userLabel = labelOf([user.valence * 0.5, 0, (1 - user.valence) * 0.4, 0, 0, (1 - user.valence) * 0.2, 0, 0.3]);
  // 关系亲和度更新：正面 +，负面 -
  const rel = state.relations[sender] || { affinity: clamp01(affinity), interactions: 0, lastAt: 0 };
  rel.affinity = clamp01(rel.affinity + (user.pos * 0.02 - user.neg * 0.03));
  rel.interactions = (rel.interactions || 0) + 1;
  rel.lastAt = now;
  if (sender) state.relations[sender] = rel;

  // 推演叙述
  const parts = [];
  parts.push(`对方（${sender || 'TA'}）此刻像是：${user.label}（正向 ${user.valence.toFixed(2)}，唤醒 ${user.arousal.toFixed(2)}）`);
  parts.push(`我对这件事的感受：${selfLabel.label} ${selfLabel.intensity.toFixed(2)}`);
  if (user.neg >= 1) parts.push('对方情绪偏低，适合轻一点、慢一点地回应，别急着讲道理');
  else if (user.pos >= 2 || user.warm >= 2) parts.push('对方情绪不错且在靠近，可以稍微活泼/亲近一点');
  else if (user.low >= 1) parts.push('对方有点敷衍/冷淡，不用贴太近，保持自然');
  else if (user.ask >= 2) parts.push('对方在问事，先答清楚，语气平和');

  // 建议语音语气（按当前情绪状态相对基线的偏移换算）
  const happyDev = Math.max(0, self[0] - BASELINE[0]);
  const sadDev = Math.max(0, self[2] - BASELINE[2]);
  const downDev = Math.max(0, self[5] - BASELINE[5]);
  const cryRaw = sadDev * 0.7 + downDev * 0.5;
  const cry = Math.max(0, Math.min(1, (cryRaw - 0.08) / 0.45));
  const pitchSemitones = happyDev * 2.2 + self[6] * 0.4 - cry * 1.3;
  const tempo = Math.max(0.8, Math.min(1.15, 0.95 - 0.08 * (sadDev + downDev) + 0.05 * happyDev));
  const tremble = cry > 0.12;

  state.self = { vector: self, updatedAt: now };
  state.history = [...(state.history || []), { at: now, sender, user: user.label, self: selfLabel.label, vector: self.map((x) => Math.round(x * 100) / 100) }].slice(-200);
  saveEmotionState(state, { memoryDir });

  return {
    user: { ...user, emotion: userLabel },
    self: { ...selfLabel, vector: self.map((x) => Math.round(x * 100) / 100) },
    narrative: parts.join('；'),
    voice: {
      pitchSemitones: Math.round(pitchSemitones * 100) / 100,
      tempo: Math.round(tempo * 1000) / 1000,
      tremble,
      cry: Math.round(cry * 100) / 100,
    },
  };
}

/** 只推进时间（不处理新事件）：用于定时 tick */
export function tick({ memoryDir, now = Date.now() } = {}) {
  const state = loadEmotionState({ memoryDir, now });
  const hour = new Date(now).getHours();
  const self = decay(state.self.vector, Math.max(0, now - (state.self.updatedAt || now)), hour);
  state.self = { vector: self, updatedAt: now };
  saveEmotionState(state, { memoryDir });
  return { self: labelOf(self), vector: self.map((x) => Math.round(x * 100) / 100) };
}
