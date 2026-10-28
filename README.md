# dsh-voice — 本地语音 + 情绪推演插件

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加一套**完全本地运行的中文语音**，并且让语音带上**连续变化的情绪状态**。

一句话：**她不只是会说话，而是带着「此刻的心情」说话。**

- 语音合成：**[IndexTTS2](https://github.com/index-tts/index-tts)** 本地推理（零云端依赖、零 API 费用）
- 情绪控制：**8 维情绪向量**（高兴/愤怒/悲伤/恐惧/反感/低落/惊讶/平静），不再靠关键词猜情绪
- 情绪推演：**推断对方情绪 → 评价事件 → 更新自己的情绪**（有惯性、回落、昼夜节律），语音默认跟着推演后的状态走
- 可选：把生成的语音**发送到 QQ**（SnowLuma / OneBot 协议），也可以只合成不发送
- 形态：**DSH Host 插件（bundle）**，安装后 agent 直接可用，无前端改动

> 本仓库只包含插件本体。IndexTTS2 模型与参考音需要你自行部署（约 10GB），插件不含模型。

---

## 功能一览

| 工具 | 说明 |
|---|---|
| `voice_say` | 合成一句中文语音。可指定 `emotion` 情绪名或 `emoVector` 8 维向量；传 `key`（`private:<QQ>` / `group:<群>`）直接发到 QQ |
| `voice_send_file` | 把已有音频文件发到 QQ |
| `voice_health` | 检查语音服务是否就绪；未就绪自动拉起并等待模型加载 |
| `voice_emotion_state` | 查看当前情绪状态（向量 / 最近一次互动 / 关系亲密度） |
| `voice_emotion_simulate` | 情绪推演：给一段对方说的话，推断对方情绪并推演自己的情绪变化 + 建议语气 |
| `voice_emotion_tick` | 只推进情绪时间（回落 + 昼夜节律） |

情绪向量顺序（**不可换**）：

```
[高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
```

情绪名只是向量的别名，内置：`开心 / 激动 / 温柔 / 撒娇 / 生气 / 委屈 / 难过 / 伤心 / 哭腔 / 惊讶 / 平静`。

不指定情绪时，`voice_say` 会读 `emotion-state.json`（情绪推演维护的当前状态）决定语气，所以连续对话里声音是**渐变**的，而不是一条消息一个表情。

---

## 安装

### 1. 准备 IndexTTS2

1. 按 [IndexTTS2 官方说明](https://github.com/index-tts/index-tts) 部署，例如 `D:\index-tts2`
2. 准备 5~15 秒干净中文参考音（16k 单声道 wav），例如 `D:\index-tts2\ref\ref.wav`
3. 记下 venv 的 python 路径（如 `D:\index-tts2\.venv\Scripts\python.exe`）和模型目录（`D:\index-tts2\checkpoints`）

### 2. 安装插件

在 DeepSeek Harness 的任意会话里让 agent 执行：

```
用 plugin_manager 的 install_bundle，安装这个目录：<绝对路径>/dsh-voice-plugin
```

安装成功后，新会话里就能看到 `voice_*` 工具（`voice_health` 可用于自检）。

### 3. 配置

两种方式（后者优先级更高）：

- **推荐**：把 `runtime/config.example.json` 复制为 `runtime/config.json`，填好路径（该文件已被 `.gitignore` 忽略，不会进仓库）
- 或：在 profile 的 `cordis.patch.yml` 里覆盖 `voice` 行的 config

配置项：

| 字段 | 说明 |
|---|---|
| `indextts2.python` | IndexTTS2 venv 的 python 可执行文件 |
| `indextts2.root` | IndexTTS2 仓库根目录（加到 `sys.path`） |
| `indextts2.modelDir` | checkpoints 目录 |
| `indextts2.refAudio` | 参考音（音色克隆用） |
| `indextts2.port` | 本地服务端口，默认 8765 |
| `indextts2.autoStart` | 服务未启动时是否自动拉起（默认 true） |
| `indextts2.idleSeconds` | 空闲退出秒数；`0` = 常驻（默认） |
| `indextts2.minFreeMb` / `minCommitMb` | 内存保护阈值（不足时拒绝加载并给出提示） |
| `qq.baseUrl` | SnowLuma / OneBot HTTP 地址，默认 `http://127.0.0.1:3000` |
| `qq.token` | OneBot access token（只合成不发送可留空） |
| `voice.vectorAlpha` | 显式情绪向量的强度（0~1） |
| `voice.stateAlpha` | 情绪推演状态的强度（0~1） |
| `memoryDir` | 情绪状态目录，默认 `~/.dsh/qq-memory` |

### 4. 自检

```
调用 voice_health
```

首次会自动拉起服务并加载模型（约 25~60 秒）。看到「语音服务就绪」即可使用：

```
调用 voice_say，text="你好呀，这是一条语音测试"，emotion="温柔"
```

需要发到 QQ 时再传 `key`，如 `private:123456789`。

---

## 情绪推演是什么

普通语音插件是「一条消息 → 一个情绪标签」；本插件把情绪当成**动态系统**：

- **三层**：瞬间情绪（事件评价）/ 心境（惯性 + 回落 + 昼夜节律）/ 关系亲密度
- **评价**：同一句话对不同关系的意义不同（亲近的人说的话情绪反应更强）
- **惯性**：新事件只推动一部分（默认系数 0.7），情绪不会瞬间跳变
- **回落**：向基线缓慢回落，负面情绪回落更慢
- **昼夜**：深夜精力更低、更脆弱
- **单次限幅**：一条消息引起的情绪变化有上限，避免夸张

详细公式、参数与状态文件格式见 **[docs/emotion-model.md](docs/emotion-model.md)**。

---

## 架构

```
Agent 工具调用
   │
   ├─ voice_say ──► 情绪来源（显式向量/别名/情绪状态）
   │                    │
   │                    ▼
   │             HTTP POST /synth ──► IndexTTS2 本地服务（8765）
   │                    │                   │
   │                    ▼                   ▼
   │               wav 音频           模型常驻/自动拉起/内存保护
   │                    │
   │                    ▼
   │         SnowLuma / OneBot（可选）──► QQ 语音消息
   │
   └─ voice_emotion_* ──► emotion.mjs（情绪推演）──► emotion-state.json
```

运行时文件：

- `lib/index.js` — Host 插件，注册工具、管理语音服务进程
- `runtime/indextts2_server.py` — 本地 HTTP 语音服务（常驻、自动拉起、CUDA/内存错误自动重启）
- `runtime/emotion.mjs` — 情绪推演（8 维向量、惯性、回落、昼夜、关系）
- `runtime/datadir.mjs` — 共享数据目录解析

## 已知限制

- 需要本地 GPU（约 6~8GB 显存）和约 6GB 提交内存；内存不足时服务会拒绝加载并给出提示，而不是硬崩
- 模型、参考音不随仓库分发
- Windows 是主要开发平台；Python 服务与 HTTP/JSON 接口是跨平台的，Linux/macOS 理论上可用但未验证
- 本插件只做「合成 + 情绪」，更细的语气后处理（分句换气、呼吸声、整体降速）属于配套的完整语音运行时，不在本仓库

## 许可

MIT，见 [LICENSE](LICENSE)。

## English quickstart

`dsh-voice` is a DeepSeek Harness Host plugin bundle that adds fully local Chinese TTS (IndexTTS2) with an 8-dimensional emotion model and emotion dynamics simulation.

1. Install IndexTTS2 locally and prepare a 5–15s reference voice (16 kHz mono wav).
2. Install this bundle via `plugin_manager install_bundle` (point it at this directory).
3. Copy `runtime/config.example.json` to `runtime/config.json` and fill in your paths.
4. Call `voice_health`, then `voice_say`.
5. Optional: set `qq.baseUrl` / `qq.token` to deliver the voice to QQ via SnowLuma/OneBot.
