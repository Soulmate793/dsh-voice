# 情绪推演模型（emotion-model）

本文件说明 `runtime/emotion.mjs` 的设计：为什么情绪不应该是「一条消息一个标签」，以及具体怎么算。

## 1. 三层结构

| 层 | 时间尺度 | 在代码里 | 作用 |
|---|---|---|---|
| 瞬间情绪 | 秒 ~ 分钟 | `appraise()` + 单次更新 | 对刚发生的事做出反应 |
| 心境 | 小时 ~ 天 | `state.self.vector` + `decay()` | 让情绪有惯性，不会一条消息跳一次 |
| 关系 | 长期 | `state.relations[qq].affinity` | 同样的话，不同的人说，反应强度不同 |

情绪用 **8 维向量**表示，顺序固定（IndexTTS2 要求）：

```
[高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
```

基线（平静时的默认状态，略偏正向）：

```js
BASELINE = [0.12, 0, 0.03, 0, 0, 0.02, 0, 0.78]
```

## 2. 从文字推断对方情绪（inferUserEmotion）

词表 + 语气特征，输出 `{ valence, arousal, label }`：

- 正向词（谢谢/喜欢/好棒…）、负向词（烦/讨厌/滚…）、亲近词（乖/抱抱/陪你…）
- 高唤醒标记（！/？？/真的假的…）、低唤醒标记（嗯/哦/随便…）
- 疲惫词（累/心累/不想…）→ 优先归为「疲惫/低落」
- `valence ∈ [0,1]`、`arousal ∈ [0,1]`，再映射成标签

> 这是启发式推断，不是精确情感分类器；替换成模型（如小型分类器）不影响后续流程。

## 3. 事件评价（appraise）

把「对方做了什么」映射成「对我意味着什么」的 8 维增量：

| 事件 | 增量 |
|---|---|
| 被夸奖/被感谢/被亲近 | 高兴↑、平静↑ |
| 被凶/被骂 | 愤怒↑、悲伤↑、低落↑、平静↓ |
| 被提问 | 惊讶↑（少量）、平静↑ |
| 高强度表达 | 惊讶↑、高兴↑ |

关系越近，反应越强：

```
closeness = 0.4 + 0.6 × affinity      // affinity ∈ [0,1]
```

## 4. 情绪更新（惯性 + 限幅）

```
新情绪 = 当前情绪 + (1 − inertia) × 评价增量
inertia = 0.7          // 新事件只推动 30%
单次变化 ≤ 0.25        // 防止一条消息把情绪拉爆
```

## 5. 回落与昼夜节律（decay）

向基线指数回落，**负面维度更慢**：

| 维度 | 时间常数 τ |
|---|---|
| 愤怒 / 悲伤 / 低落 | 3 小时 |
| 其余（高兴/平静等） | 1.2 小时 |

```
value(t) = baseline + (value − baseline) × exp(−Δt / τ)
```

昼夜修正（按小时）：

| 时段 | 系数 | 效果 |
|---|---|---|
| 0–6 点 | 0.7 | 深夜：正向压低、低落上抬（更脆弱） |
| 6–9 点 | 0.85 | 刚醒 |
| 9–12 点 | 1.0 | 正常 |
| 12–18 点 | 1.05 | 下午偏高 |
| 18–21 点 | 1.0 | 正常 |
| 21–24 点 | 0.9 | 入夜 |

## 6. 主导情绪（labelOf）

不是「向量最大值」，而是**相对基线的偏移最大者**。平静是基线，不应该永远压过真实情绪：

```
deviation[i] = vector[i] − baseline[i]
label = argmax(deviation)   // deviation < 0.06 → 平静（强度 0.1）
intensity = clamp((maxDeviation − 0.06) / 0.45, 0, 1)
```

## 7. 语气换算（voice）

推演结果直接给出语音建议：

```
happyDev = max(0, 高兴 − 基线)
sadDev   = max(0, 悲伤 − 基线)
downDev  = max(0, 低落 − 基线)
哭感 cry = clamp((悲伤×0.7 + 低落×0.5 − 0.08) / 0.45, 0, 1)

音高（半音） = happyDev × 2.2 + 惊讶 × 0.4 − cry × 1.3
语速        = clamp(0.95 − 0.08×(sadDev+downDev) + 0.05×happyDev, 0.8, 1.15)
颤音        = cry > 0.12
抽噎        = cry ≥ 0.55
```

完整语音运行时（`voice/say.mjs`）用这些参数做后期处理；本插件把情绪向量直接交给 IndexTTS2（原生支持情绪向量），不做 ffmpeg 后处理。

## 8. 状态文件

`emotion-state.json`（默认在 `~/.dsh/qq-memory/`）：

```json
{
  "version": 1,
  "self": { "vector": [0.1, 0.05, 0.09, 0, 0, 0.12, 0, 0.8], "updatedAt": 1793210000000 },
  "relations": {
    "123456789": { "affinity": 0.82, "interactions": 41, "lastAt": 1793210000000 }
  },
  "history": [
    { "at": 1793210000000, "sender": "123456789", "user": "疲惫/低落", "self": "低落",
      "vector": [0.1, 0.05, 0.09, 0, 0, 0.12, 0, 0.8] }
  ]
}
```

`history` 保留最近 200 条，可用于画情绪曲线。

## 9. 参考文献

- Scherer, K. R. (2001). Appraisal considered as a process of multilevel sequential checking.（评价理论）
- Kuppens, P., et al. (2010). Emotional inertia and psychological maladjustment.（情绪惯性）
- Verduyn, P., et al. (2009). Predicting the duration of emotional experience.（情绪时长）
- Fredrickson, B. L. (2013). Updated thinking on positivity ratios.（正负情绪比例，存在争议）
- 昼夜节律与正性情绪：多项经验采样研究（ESM）报告白天正性情绪先升后降
