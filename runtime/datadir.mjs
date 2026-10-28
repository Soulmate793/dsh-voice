// 共享数据层：所有机器人实例（不管几个 QQ 号/几台机器）共用同一套「大脑」数据。
//
// 数据目录解析顺序：
//   1. 环境变量 MEMORY_DIR（最优先，适合临时/多实例指定）
//   2. ~/.dsh/dsh-memory.json 里的 dataDir（共享配置，推荐）
//   3. 默认 ~/.dsh/qq-memory
//
// 共享的数据文件：
//   memory.json       记忆库
//   profiles.json     用户画像
//   personality.json  成长式性格
//   memory.json.lock / personality.lock / profiles.json.lock  跨进程锁（并发安全）
//
// 多机器人用法：
//   - 每个机器人实例（各自的 SnowLuma / 桥接）都设置同一个 dataDir（或 MEMORY_DIR）
//   - 每个实例启动记录器时用不同的 BOT_ID（例如 BOT_ID=bigfish / BOT_ID=deepseek），
//     这样各自的单实例锁互不冲突；记忆写入走共享锁，不会互相覆盖
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'qq-memory');
export const SHARED_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'dsh-memory.json');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 读取共享配置（不存在则返回 null） */
export function readSharedConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHARED_CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 解析共享数据目录 */
export function resolveDataDir() {
  const fromEnv = process.env.MEMORY_DIR;
  if (fromEnv) return expandHome(fromEnv);
  const cfg = readSharedConfig();
  if (cfg?.dataDir) return expandHome(cfg.dataDir);
  return DEFAULT_DATA_DIR;
}

/** 写入共享配置模板（首次初始化用，不覆盖已有配置） */
export function initSharedConfig({ dataDir = DEFAULT_DATA_DIR, bots = [] } = {}) {
  if (fs.existsSync(SHARED_CONFIG_FILE)) return { created: false, file: SHARED_CONFIG_FILE };
  fs.mkdirSync(path.dirname(SHARED_CONFIG_FILE), { recursive: true });
  const payload = {
    version: 1,
    dataDir,
    // 多机器人：一一列出各自的身份（BOT_ID 用于各自记录器的单实例锁，互不冲突）
    bots: bots.length
      ? bots
      : [
          { botId: 'bigfish', uin: 3697032500, note: '大肥鱼（本机 SnowLuma）' },
          { botId: 'deepseek', uin: 3811207467, note: 'deepseek（示例，按需填写/删除）' },
        ],
    note:
      '所有机器人实例共用 dataDir 里的 memory.json / profiles.json / personality.json；' +
      '每个实例启动记录器时设置环境变量 BOT_ID=<bots[].botId>，单实例锁互不冲突。',
  };
  fs.writeFileSync(SHARED_CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return { created: true, file: SHARED_CONFIG_FILE };
}

/** 当前实例的 bot 标识（用于记录器单实例锁） */
export function resolveBotId() {
  const envId = process.env.BOT_ID;
  if (envId) return String(envId).replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  const cfg = readSharedConfig();
  const first = cfg?.bots?.[0]?.botId;
  return first ? String(first) : 'default';
}
