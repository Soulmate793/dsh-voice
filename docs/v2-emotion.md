# dsh-voice v2 说明：带情绪的语音模块

> 适用版本：v2.0.0
> 仓库：https://github.com/Soulmate793/dsh-voice

这份文档说明 v2 的语音/情绪设计、参数含义、安装配置和已知限制。

---

## 1. 它解决什么问题

v1 只能"把文字念出来"，情绪只有强弱两档，听感接近念稿。
v2 让语音带上**可辨识的语气**：

- 开心：音高上抬、语速加快、音量略增
- 撒娇：音高上抬、语速稍慢、语气更软
- 温柔：音高略降、语速放慢、音量收一点
- 惊讶：音高明显上抬、语速加快
- 委屈：轻微升调 + 音量下降
- 伤心：双档处理（见下）

所有音高变化都用 **Praat PSOLA** 实现，只改音高曲线，**不改共振峰/音色**。

---

## 2. 情绪语气参数表

| 情绪 | 音高偏移 | 语速 | 音量 |
|---|---|---|---|
| 开心 | +1.2 半音 | +8% | +6% |
| 撒娇 | +0.9 半音 | -3% | +2% |
| 温柔 | -0.5 半音 | -6% | -5% |
| 惊讶 | +2.0 半音 | +10% | +8% |
| 委屈 | +0.3 半音 | -3% | -8% |
| 伤心（高强度） | 不变调 | tempo 0.983 | 0.8 + 结尾淡出 |
| 伤心（低中强度） | 结尾降调 | 不变 | 1.0 → 0.7 + 结尾淡出 |

强度 `emotion-alpha` 会等比缩放这些偏移，0 附近接近正常说话，1 附近最夸张。

---

## 3. 伤心语音的双档设计

### 高强度（默认）

```
emoVector = [0, 0, 0.6, 0, 0, 0.35, 0, 0.1]
emotion-alpha = 0.93
tempo = 0.983
volume = 0.8
结尾 0.22s 淡出
无「啊/呜」前缀，无 vibrato
```

### 低中强度（cry ≤ 0.62）

- 用 `pitch_contour.py`（Praat PSOLA）只降**结尾**音高
- 整段音量 1.0 → 0.7
- 结尾 0.35s 淡出
- tremolo 收窄到 0.14 ~ 0.20，避免"激动/发抖"

---

## 4. 情绪跟随记忆

当调用 `voice_say` **不传 emotion** 时：

1. 读取 `~/.dsh/qq-memory/emotion-state.json`
2. 用 `stateAlpha`（默认 0.4）缩放当前心情向量
3. 从向量推断情绪名（开心/难过/温柔/惊讶/生气）
4. 套用对应语气参数

所以她"今天心情好"和"今天低落"，语音会不一样。

---

## 5. 安装

```powershell
dsh plugin install Soulmate793/dsh-voice
```

或：

```powershell
git clone https://github.com/Soulmate793/dsh-voice
dsh plugin install .\dsh-voice
```

### 依赖

- IndexTTS2（Python 环境 + checkpoints）
- ffmpeg（用于降调/语速/音量后处理）
- Python `parselmouth`（PSOLA 降调，RVC 自带 runtime 里通常已有）

### 配置

把 `runtime/config.example.json` 复制为 `runtime/config.json`，填：

```json
{
  "indextts2": {
    "python": "D:\\\\index-tts2\\\\.venv\\\\Scripts\\\\python.exe",
    "root": "D:\\\\index-tts2",
    "modelDir": "D:\\\\index-tts2\\\\checkpoints",
    "refAudio": "D:\\\\index-tts2\\\\ref\\\\ref_daniya_15s.wav",
    "port": 8765,
    "ffmpegDir": "C:\\\\Users\\\\you\\\\RVC\\\\ffmpeg",
    "speed": 1.05,
    "emotionAlphaSad": 0.93,
    "stateAlpha": 0.4
  },
  "qq": {
    "baseUrl": "http://127.0.0.1:3000",
    "token": "<onebot-token>"
  }
}
```

---

## 6. 工具

| 工具 | 作用 |
|---|---|
| `voice_say` | 合成并发 QQ；支持 `emotion`、`emoVector`、`key`、`dry-run` |
| `voice_emotion_set` | 设定她自己的当前情绪（影响后续语音） |
| `voice_emotion_state` | 查看当前情绪向量 |
| `voice_emotion_simulate` | 根据一段话推演情绪 |
| `voice_emotion_tick` | 仅推进情绪衰减 |
| `voice_health` | 检查/拉起语音服务 |
| `voice_send_file` | 发送已有音频到 QQ |

---

## 7. 已知限制

- 8GB 显存 + 16GB 内存的机器，TTS 与 ASR 同时常驻很紧张；建议页面文件 ≥32GB
- PSOLA 只能做音高曲线，做不到连续滑音级的大幅 pitch glide
- 模型权重不随插件打包，需要本机自备 IndexTTS2
- 情绪强度仍依赖 `emotion-alpha`；建议 0.5（轻）~0.93（重）之间使用

---

## 8. 变更记录

- v2.0.0：情绪语气档案、PSOLA 音高曲线、伤心双档、情绪跟随记忆、say.mjs 委派
- v1.0.0：基础 TTS + 情绪向量 + QQ 发送
