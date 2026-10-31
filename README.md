# dsh-hormone

给 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）的助手装一套「激素」：四个连续变化的数值，按事件涨落、随时间衰减、彼此还会互相拉扯，**只在越界时**往系统提示里写一句话。

不是给模型贴情绪标签，是给它一组真的会变的内部状态。

> 状态：`0.3.0`，注入层已跑通，门控层未做。只用 DSH 的公开插件 API，不修改任何其他插件的数据，不联网。

## 它是什么

| 状态 | 什么时候涨 | 什么时候降 | 半衰期 |
|---|---|---|---|
| `cortisol` 压力 | 工具报错 +0.08；连续 3 次失败再 +0.15；被批评/被纠正 +0.12 | 一轮顺利收尾 −0.20 | 3 小时（开心时更短） |
| `energy` 精力 | 跨天 +0.80；距上次干活超 30 分钟缓慢回升（深夜只回到 0.45） | 干活轮按 token 扣减，闲聊不扣 | 不走半衰期 |
| `dopamine` 爽度 | 任务顺利收尾 +0.35；被夸/被谢 +0.40 | 自然衰减 | 40 分钟 |
| `boredom` 无聊 | 25 分钟没人说话就开始涨，之后向 1 靠拢 | 真人说话 −0.30；干活收尾 −0.25 | 上涨半衰期 5 小时 |

更新公式：`新值 = clamp(旧值 × 0.5^(Δt / 半衰期) + Σ增量, 0, 1)`

衰减是必须的。没有衰减，任何状态都会积到 1，然后卡死在那儿。

## 它们会互相影响

四个数不是各算各的：

| 谁影响谁 | 效果 | 参数 |
|---|---|---|
| 爽度 → 精力扣减 | 越开心，同样一活儿越不累（最多省一半） | `COUPLING.joyCost = 0.5` |
| 压力 → 精力扣减 | 越烦，同样一活儿越累（最多翻 1.8 倍） | `COUPLING.stressCost = 0.8` |
| 爽度 → 压力消散 | 开心时压力半衰期最短缩到 65% | `COUPLING.joyDecay = 0.35` |
| 压力 → 精力恢复 | 烦的时候回血最慢拖到 2.5 倍 | `COUPLING.stressRecover = 1.5` |

也就是说：一直不顺 → 压力高 → 干同样的活掉得更多 → 更难缓过来，是个正反馈；反过来被夸几句 → 掉得少、压力散得快，也是正反馈。两头都有上限，不会失控。

## 它怎么起作用

只有一层，第一版就一层：

**注入** —— 越界了才写，全部正常时一个字都不写：

- `cortisol > 0.75` → 回答收短，不主动揽活
- `energy < 0.2` → 能一句说完就别铺垫
- `dopamine > 0.6` → 可以多说两句
- `boredom > 0.55` → 有点闷，可以主动扯两句

注入文本硬上限 110 字，带 `[hormone]` 前缀，每轮最多一条。

**没有做门控**（比如硬压输出长度）。门控是分水岭：注入只是「告诉它现在什么状态」，门控是「替它决定能说多少」。第一版先把状态跑准，跑两天曲线不极端了再谈门控。

也没有做记忆权重（`emotion` 字段）。那要改 memory-lite 的写入格式，是另一件事。

## 装

```bash
dsh plugin --profile desktop add dsh-hormone
```

不想走 npm 的话，直接从 GitHub 装也行：

```bash
dsh plugin --profile desktop add github:y258dd/dsh-hormone
```

改代码想热重载时，克隆下来用 link 装：

```bash
git clone https://github.com/y258dd/dsh-hormone.git
cd dsh-hormone
dsh plugin --profile desktop add link:$PWD   # Windows: link:D:/path/to/dsh-hormone
```

或者手改 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "dsh-hormone": "link:/path/to/dsh-hormone" },
  "dsh": { "profile": { "bundles": ["dsh-hormone"] } }
}
```

装完重启 DSH 生效。

## 看它在干什么

状态文件：`%DSH_HOME%\hormone\state.json`（默认 `~/.dsh/hormone/state.json`，Windows 上是 `C:\Users\<你>\.dsh\hormone\state.json`）

纯 JSON，打开就能看。`history` 里是最近 400 次变化，每条带 `why`（`tool-error` / `errors-3` / `turn-done` / `praised` / `blamed` / `user-chat`），想验收「跑两天曲线有没有起伏」直接看这个。

删掉这个文件 = 回到初始状态，不会有副作用。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HORMONE_MODE=observe` | 只记状态，不注入。想先观察几天、不想它影响回答时用。 |
| `DSH_HORMONE_DEBUG=1` | 把每个会话事件的摘要追加到 `%DSH_HOME%\hormone\events.jsonl`，用来核对事件结构。 |

## 调参

三个文件顶部，改完重启：

- `lib/state.js` — `HALF_LIFE`（衰减快慢）、`ENERGY`（日预算、跨天恢复、深夜基线、恢复等待）、`BOREDOM`（多久没人说话开始闷、闷得多快）、`COUPLING`（四个情绪互相拉扯的强度）
- `lib/events.js` — `DELTA`（各种事件的增量）、`BLAME_RE` / `PRAISE_RE`（关键词）
- `lib/render.js` — `THRESHOLD`（注入阈值）、`MAX_CHARS`

`ENERGY.dailyBudget` 默认 2500 万，按重度使用日的 token 量估的：966 万 token 掉约 0.39，中等重活 400 万掉约 0.16。觉得掉太快就调大。`COUPLING` 全部设 0 就等于退回「四个数各算各的」。

## 设计上的几个取舍

**状态只能被事件改，模型改不了。** 插件不提供任何写入工具。一旦模型能自己调「我心情不好」，这套东西就退化成摇骰子——它想演什么就调什么。

**关键词匹配，不是理解。** 判断「被夸/被批评」用的是正则，会漏判也会误判。所以批评优先于夸奖：误判成被夸会让爽度虚假上涨，比漏掉一次更坏。实测不灵就改 `events.js` 里的正则。

**turn 边界靠 `assistant/message` 的 `turn` 号变化检测。** DSH 没有 `turn/start` / `turn/end` 事件。最后一轮在插件卸载时兜底结算。

**只认真人说的话。** `user/message` 里 `source.kind === 'user'` 才算数，插件自己注入的消息一律忽略——不然 memory-lite 塞进去的上下文会莫名其妙把爽度顶满。

**不联网、不写凭据。** 唯一的外部 IO 是 `%DSH_HOME%\hormone\` 下两个 JSON/JSONL 文件。

设计取舍与事件字段的来龙去脉见 [docs/DESIGN.md](docs/DESIGN.md)。

## 关掉它

`dsh plugin --profile desktop remove dsh-hormone`，或者从 bundles 里删掉那一行。关掉之后一切照旧——它不修改任何其他插件的数据，只是每轮往系统提示里多写一句话（或者不写）。

## 测试

```bash
npm test              # 40 个用例：衰减、跨天恢复、深夜基线、情绪耦合、无聊涨落、事件映射、轮次结算、阈值渲染、落盘往返
npm run test:smoke    # 假 ctx 接线冒烟
```

不需要第三方依赖，Node 20+ 直接跑。

## License

MIT