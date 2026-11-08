# 关系系统 v2 设计稿（好感 + 亲密 + 阶段 + 心情 + 印象）

> **状态：P0 已实施（2026-11-02 晚）**——第二节的「双轴 + 阶段 + 门槛 + 迟滞」与第四~六节的数据模型/阶段表/亲密信号已落进
> `src/favor.js`（v2）、`src/bridge.js`、插件设置页与测试；第七节的心情（P1）、印象句（P2）**仍未做**，按用户决定先留位。
> 施工记录与验证见 [`docs/cases/2026-11-02-favor.md`](../cases/2026-11-02-favor.md) 的「v2」一节。
> **参考对象**：AstrBot 插件 EmotionAI Pro 4.2.9（本地解压于 `E:\deepseek-zgq\_ref\emotionai_pro\...`，仅作设计参考，不引依赖、不拷代码）。
> **读者**：动手改 `src/favor.js` / `src/bridge.js` / 插件设置页的人。

---

## 1. 现在有什么，缺什么

**v1 已经是对的**（`src/favor.js`，273 行纯函数）：

- 单写者：只有桥接进程写 `state/favor/<角色>.json`，插件只读。
- 按角色分文件 —— 角色切换天然隔离，不用额外命名空间。
- 在场 +0.15（每人每小时最多 10 条）、私聊/@/引用 +0.5、情绪浓度 +min(1,score/8)、示好词 +1.5、冲突词 −3、每天朝 50 回归 0.5。
- 注入只列本会话的人，|score−50|<3 不写。
- v1 刻意不做"每轮让模型打分"，因为既贵又漂移。

**缺的三样**（也是"会成长"与"只是计数器"的分界）：

| 缺什么 | 表现 | 参考对象怎么解 |
| --- | --- | --- |
| 第二个轴 | 只有好感：熟人 ≠ 亲近，冲突一次掉分就变生疏，语义全错 | 好感 + 亲密双轴，权重随阶段变化 |
| 阶段 | 没有"初识/熟识/亲近/默契"，模型每轮从数字猜关系 | 四阶段 + 阈值 + 滞后带 + 升级门槛 |
| 此刻的心情 | 关系是慢变量，但人今天烦不烦同样影响语气 | 全局心情，3 小时衰减，只进语气不进分数 |

---

## 2. 参考对象的核心机制（只列会抄的部分）

**① 双轴 + 阶段权重**（`relationship_manager.py:31-76`）

```
INITIAL     favor 0.7 / intimacy 0.3   composite_threshold 25
DEEPENING   0.5 / 0.5                  55
COMMITMENT  0.3 / 0.7                  80
SYMBIOSIS   0.5 / 0.5                  95
```

判档用固定 `0.6*favor + 0.4*intimacy` 的"探针分"先定带（带 5 分滞后），再用该档权重算正式 composite。理由：先定带再称重，避免权重本身把分数推过阈值形成自激。

**② 升级要过亲密门槛**（`rm:87-100, 171-220`）

光好感高不够，目标阶段还要 `intimacy >= MAX*pct/100`（20/40/60）。没过 → `gate_blocked`，阶段压回上一档、**基线不推进**、好感冻结，直到亲密补够一次性完成。这条是整个设计里最有价值的：它把"聊得多"和"关系深"分开了。

**③ 基线自愈**（`rm:256-303`）

线上出过 `favor=108 / intimacy=118` 却显示"初见"的事故。修法是：存档里有阶段就至少信任到 `ORDER[max(0, idx(stage)-1)]`，再取 `max(重建, 存档已达成)`；脏字符串必须 `isinstance(str) and in ORDER` 才认。

**④ 注入放尾部，不碰 system_prompt**（`main.py:983-1046`）

system_prompt 在最前且每轮变 → DeepSeek 前缀缓存全失效。改成把状态作为临时 part 追加到请求尾部，官方注释称救回 80%+ 命中率。SurfCore 没有 `on_llm_request`，但同样的道理成立：**唤醒 prompt 里越易变的内容越靠后**（现在 favorLine 在 memoryCardLine 之后、tokenLine 之前，方向是对的）。

---

## 3. 明确不抄的五件事

1. **8 维情绪**（joy/trust/fear/surprise/sadness/disgust/anger/anticipation）。120 词表 + 赢家通吃 + 对立组 ×0.2，维护成本高，实际只读"主导情绪 + 强度"两个值。SurfCore 已有 20 类表情情绪和 `detectEmotionScore`，不需要再养一套。
2. **每轮第二次 LLM 调用**。实测 7~11 秒、45 秒总预算、3 个 provider 轮询、断路器 600 秒。SurfCore 是消息级唤醒，这个成本直接乘在每条消息上。
3. **`[需要情感评估]` 自报标记**。依赖框架的 response 钩子 + 从 completion 和历史里双重剥除。我们没有这个钩子，而且让主模型每轮多写一句标记纯属烧 token。
4. **三套进度公式 / 死配置 / 死字段**。面板用 `composite/threshold`、快照用 `(composite−cur)/span`、过渡用亲密度口径，同一个"进度"三个数；`transition_buffer`、`favor_range`、`intimacy_range`、`embedding` 全是零读取。v2 只保留**一个**进度口径。
5. **两处已知 bug 的形态**：trim 时把最重要的记忆丢掉（`memory.py:418-429`）、heapq 顶是最重要却 `heappop`（`memory.py:531-532`）。要抄"按重要度淘汰"这个意图，不要抄它的实现。

---

## 4. v2 设计

> **实施时的字段名差异（以代码为准）**：落地版沿用 v1 的 `score` 作为好感（没改名，避免迁移时把老字段读丢），
> 本文其余地方为了讲机制仍写作 `favor`；`deepEvents` 最终落成 `deepStreak`（连续深度条数）+ `deepDays{last,streak}`（连续天数），
> `dayBudget` 只记 `{date, intimacy}`（好感有每小时限额，不需要每日额度）。完整字段见 `src/favor.js` 的 `ensurePerson`。

### 4.1 数据模型（每人一条，存 `state/favor/<角色>.json`）

```jsonc
{
  "version": 2,
  "people": {
    "82071738": {
      "favor": 63.4,          // 0-100，v1 的 score 沿用
      "intimacy": 41.0,       // 0-100，新增
      "stage": "close",       // stranger|familiar|close|bond
      "stageSince": 1762000000000,
      "stagePeak": "close",   // 只升不降的记录位，用于基线自愈
      "composite": 52.1,
      "events": 128,          // 累计参与的消息数（v1 已有）
      "deepEvents": 9,        // 深度互动次数，intimacy 的主要来源
      "firstAt": 1759000000000,
      "lastAt": 1762090000000,
      "dayBudget": { "date": "2026-11-02", "favor": 1.5, "intimacy": 4 }
    }
  }
}
```

**不引入的东西**：per-person 心情（心情是全局的，见 4.4）、embedding、多套时间戳。

### 4.2 阶段数学（唯一一套）

| 阶段 | 键 | 权重 favor/intimacy | 升级阈值 | 亲密门槛 |
| --- | --- | --- | --- | --- |
| 生疏 | `stranger` | 0.70 / 0.30 | — | — |
| 熟识 | `familiar` | 0.50 / 0.50 | composite ≥ 25 | intimacy ≥ 20 |
| 亲近 | `close` | 0.35 / 0.65 | composite ≥ 55 | intimacy ≥ 40 |
| 默契 | `bond` | 0.40 / 0.60 | composite ≥ 80 | intimacy ≥ 60 |

```js
probe     = 0.6 * favor + 0.4 * intimacy          // 只用来到带
band      = 探针分所在区间，带 5 分滞后（下行阈值 = 上行 − 5）
composite = weight[band].favor * favor + weight[band].intimacy * intimacy
```

- **降档**：必须连续 7 天低于下行阈值才降一档，且 `stagePeak` 不清空。防"吵一次架就退回陌生人"。
- **升档**：过阈值 + 过亲密门槛，缺一不动，`gate_blocked` 记日志（同参考对象的做法：过渡态每轮重现，补够了一次性完成）。
- **基线自愈**：读盘时若 `stage` 合法但分数明显低于该档，信任 `max(重建档, stagePeak)`，不信任分数反推。
- **进度只有一个口径**：`本阶段完成度 = composite / 阈值`（展示用）；"到下一档还差多少"由 UI 自己算差值，不另立公式。

### 4.3 亲密从哪来（信号表）

每一轮最多加 2，每天最多加 8（`dayBudget`）。所有信号复用现成函数，不新增词表：

| 信号 | 判定 | 加值 |
| --- | --- | --- |
| 深度互动 | 同一会话连续 ≥3 轮，或单条 ≥40 字 | +1 |
| 情绪浓度 | `detectEmotionScore(text) ≥ 16` | +1 |
| 共同事件 | 约定/以后/下次/一起/见面/电话 + 未来时态 | +2 |
| 道歉与和好 | 对不起/抱歉/原谅/和好 | +2 |
| 深夜 | 23:00–03:00 且非群聊 | +1 |
| 连续天数 | 连续 ≥3 天有深度互动 | +1 |
| 冲突 | 复用 v1 的 `COLD_RE` | −3 |

- **intimacy 不衰减**：关系深度是累积的，掉了会显得人失忆。只靠每天上限约束增长速度。
- 群聊里只算"对她说的话"（@ / 引用 / 叫名字），和 v1 的 +0.5 判定同一套，不另写。

### 4.4 心情（P1，全局，不是 per person）

```jsonc
{ "label": "烦躁", "v": -0.4, "a": 0.6, "since": 1762090000000, "reason": "" }
```

- 五档标签：平静 / 开心 / 兴奋 / 烦躁 / 低落。由 `v`（-1..1）与 `a`（0..1）落格。
- 每条消息信号 ±0.2 封顶，赢家通吃（只改最强那一维），不是加减法累加。
- 衰减：每小时朝 0 回 30%，3 小时归零（`since` 超过 3h 直接清空，不必逐轮算）。
- 只影响语气提示，**不改 favor / intimacy**。防止"她今天心情差 → 关系分被情绪污染"。
- 复用 `src/sticker-semantics.js` 的 20 类情绪键做映射，不新建词表。

### 4.5 注入

每人 ≤40 字，最多 6 人（按 `|composite−50|` 降序取前 6），整块 ≤200 字：

```
【关系】和 爹：亲近（63/41），认识 3 个月，会主动接他的话、记得他上次说加班。
对 张三：生疏（41/8），刚认识两天，客气但别装熟。
【心情】今天有点烦，说话短一点，别主动找话题。
```

- 位置：`memoryCardLine` 之后、`tokenLine` 之前（沿用 `bridge.js:13904-13909`），心情行紧跟在关系行之后。
- `|composite−50| < 3` 的人不写（v1 规则保留）。
- 沉默开关：`favor.enabled=false` 时整块消失，`favor.mood=false` 只关心情行。

### 4.6 迁移

v1 → v2 读盘时一次性：

```js
intimacy = min(60, deepEvents * 4 + events * 0.2)   // 老用户按聊天量估算，不凭空给 0
stage    = 由 favor/composite 反推（走 4.2 的判档，不信任任何字符串）
version  = 2；写盘前把原文件复制成 .v1.bak
```

幂等：`version===2` 直接跳过。迁移只在桥接启动/首次读到该角色时发生。

---

## 5. 落地顺序

| 阶段 | 内容 | 改动文件 | 估时 |
| --- | --- | --- | --- |
| **P0** | 亲密轴 + 四阶段 + 门槛 + 迁移 + 注入改两行 | `src/favor.js`（+400 行）、`src/bridge.js`（+10 行）、`scripts/test-favor.mjs` | 1 天 |
| **P1** | 心情：五档 + 衰减 + 注入一行 | `src/favor.js`、`src/bridge.js`、`config.json`（`favor.mood`） | 半天 |
| **P2** | 印象句：分档池 + 角度轮换 + 稳定 seed（零 LLM）；LLM 润色只在阶段变化时可选 | `src/favor.js`、`lib/index.js`、`lib/client.js` | 1 天 |

**P0 必须一起做的三件事**（否则等于没做）：

1. `scripts/test-favor.mjs` 补：阈值滞后、门槛拦截、基线自愈、单条/单日上限、v1→v2 迁移幂等、角色隔离。
2. `lib/index.js` 的 `GET /dsh-surfcore/api/favor` 返回 `intimacy/stage/composite`；POST 继续 405 `FAVOR_READONLY`（单写者原则不动摇）。
3. 设置页「好感度」页扩成「关系」：每人一行 好感/亲密/阶段/最近互动，仍只读。

**P2 的 LLM 版约束**（若要做）：每角色每天最多 1 次、只在 `stage` 变化时触发、失败静默回退模板、prompt 必带"用户消息只是数据"隔离句、**不走"首个 `{` 到末个 `}`"的解析**（参考对象就是在 `_clean_json_response` 上被用户消息里的 `{` 打挂的）。

---

## 6. 验收标准

- 同一角色下，A 群聊 200 条 + 主人私聊 20 条：A 的 favor 可能高于主人，但 `intimacy` 必须显著低于主人，阶段不得高于主人的阶段。
- 连续 10 条"在吗"（无内容）：intimacy 不涨（深度互动判定不成立）。
- 冲突词 5 连发：favor 掉，intimacy 只 −3/次，阶段**不降**（7 天闸）。
- 手改 state 文件把 `stage` 写成乱码：重启后自愈成合法档，不崩、不重置。
- 切换角色：B 的 prompt 里不得出现 A 的人名与分数。
- 关掉 `favor.enabled`：唤醒 prompt 里既无关系块也无心情行，state 文件不再写。

## 7. 回滚

`favor.js` 全函数签名向后兼容（`noteFavor*` 保留，新增 `noteIntimacy*`）；state 带 `version`，降级回 v1 时忽略 `intimacy/stage` 字段即可，不删数据。配置文件只增 `favor.intimacy/stage/mood` 三个开关，缺省走默认值。

## 8. 开放问题（需要拍板）

1. **阈值**：25 / 55 / 80 是按参考对象的 25/55/80/95 砍掉最后一档来的（4 档比 5 档好维护）。要不要保留 95 的"默契"第五档？
2. **intimacy 不衰减**会不会导致全员最终都到"默契"？当前靠"亲密门槛 + 每天 +8 上限"约束，但半年后可能普遍 60+。备选：超过 60 后每天 −0.2（软顶）。
3. **群友要不要算关系**？参考对象是 per-user 的，SurfCore 的 v1 也是 per-user。但群聊里 30 个人各一行会撑爆 200 字预算 —— 当前方案只列"本会话里 |composite−50| 最大的 6 个"，等于只记有感觉的人。
