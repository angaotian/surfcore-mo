# 设置页补齐「思考与读法」入口 + 控制台令牌两份不一致（排查 401 的坑）

## 现象

- 用户看到什么（原话尽量保留）：
  - 「检查我加进来的功能完整性」→ 审计结论是 6 套本地功能都在，但发现 **think（思维链式读法）没有设置页入口**：`src/think.js` 一直读 `config.json` 的 `socialV2.think`，可当前配置里根本没有这个键，用户只能手写 JSON 才知道它能关、能换风格。
  - 同一次审计还发现：`state/console-token` 里是旧的 48 位令牌（`cfb3adb7…`），而 `config.json` 里生效的是 32 位（`fca18c1c…`）。**用文件里的令牌请求控制台永远 401**，真正的令牌在 config 里。
- 复现步骤：
  1. 打开 SurfCore 设置页 → QQ 页 → 高级参数：找不到任何「读法 / 思考」相关字段。
  2. 用 `state/console-token` 的内容请求 `GET http://127.0.0.1:3100/api/status` → `401 {"ok":false,"error":"未授权：请提供控制台访问令牌"}`；换成 `config.json` 的 `consoleToken` → 200。
- 影响面：不丢数据；think 只是"没法调"，默认值（开、auto、3 点）一直在生效；令牌不一致是**潜伏**故障——日常不报错，只在「有人照文档去读 `state/console-token`」或「config 里那行被删」时炸。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 桌面版（runtime node v24.21.0） |
| SurfCore 版本 | 0.8.9（合并上游 v0.8.9 之后的本地定制版） |
| 安装方式 | junction（`~/.dsh/plugins/surfcore` → `E:\DSH-Data\surfcore\plugins\surfcore`） |
| 其它相关版本 | 桥接 `src/bridge.js` 运行中（consolePort 3100） |

## 根因

- 代码位置（文件:行）：
  - `src/think.js:31` `normalizeThinkConfig(raw)`：缺省即开（`enabled: src.enabled !== false`）、`style` 只认 `auto|brief|chatty|dry`、`maxPoints` 夹在 2–5。
  - `src/bridge.js:15368` 附近：`const thinkLine = buildThinkBlock({ cfg: cfg.socialV2?.think, … })` —— **运行时确实读这个键**。
  - `plugins/surfcore/lib/client.js` 的 `QQ_FIELDS`（`:1128` 起）：**没有** `socialV2.think.*` 三行 → 设置页无从渲染。
  - `src/bridge.js:344` `loadOrCreateConsoleToken()`：只「读文件，没有就生成」，**从不会把 config 里配置的令牌写回文件**；而 `startConsoleServer()` 优先用 `cfg.consoleToken`。两条来源各自为政，谁也管不到谁。
  - `plugins/surfcore/lib/bridge.js:27-32` `consoleToken()`：先读 `config.json`，读不到才回退文件 → 插件侧一直是好的，所以问题只在"非插件读者"身上（`scripts/send-voice.mjs`、`scripts/tag-stickers.mjs`、`scripts/test-console.mjs` 等都直接读文件）。
- 问题链条（为什么会导致上面的现象）：think 是"先写运行时、后补 UI"的顺序做出来的——运行时读 `socialV2.think`，UI 没跟上，于是**功能默认生效但不可见**。令牌则是"两处都能存"，没有单一真相：config 改了文件不变，文件改了 config 优先，两边就永久分叉。
- 为什么之前没发现（测试盲区 / 只在开发机验证过 / 自测绕过了某条路径）：`test-think.mjs` 只测纯函数（`buildThinkBlock` / `normalizeThinkConfig`），**不测设置页有没有入口**；令牌不一致在日常路径上永远不会报错（config 有值就一直走 config），只有手工拿文件里的值去请求才暴露。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - think：`config.json` 的 `socialV2.think` → `bridge.js` 唤醒时 `buildThinkBlock()` → 拼进唤醒 prompt 的「【读法】」段 → 模型回复前先在心里过一遍要点。**没有未读消息时不注入**（主动搭话 / 潜水收尾不白烧 token）。
  - 令牌：`config.consoleToken`（有则用）→ 否则 `loadOrCreateConsoleToken()` 读/生成 `state/console-token` → 控制台 API 用 `crypto.timingSafeEqual` 校验 `?token=` 或 `x-console-token`。
- **机制**：think 是**纯开关型配置**，UI 只是"编辑同一份 JSON 的手指"；设置页保存走 `POST /config`（插件）→ 整份 QQ 配置回写 → 桥接下一次唤醒就读到新值（无需重启桥接，只有语音/MCP 工具面才要重启 DSH）。令牌是**凭据**，一旦两处都能写就必须指定唯一真相，否则读取方（脚本、插件回退、用户手抄）会各自踩到不同版本。
- **爆炸半径**：进程数 1（桥接）× 读者数 4+（插件、`send-voice`、`tag-stickers`、`test-console`）× 静默=3 → 偏高。碰密钥（控制台令牌可改配置 / 发消息 / 读聊天记录），**不碰用户数据本体**，不花钱。
- **取舍**：
  - 备选 A：把 `state/console-token` 删掉，只留 config → 但 `loadOrCreateConsoleToken()` 是"config 为空"时的合法兜底，删了会在 config 缺字段时变成 401 而不是自动生成，反而更脆。
  - 备选 B（选它）：**生效令牌确定后，把文件对齐成同一个值**。收益：两处永远一致，兜底链路仍在；成本：启动多一次读 + 极少写；风险：几乎为零（写的是 state 目录，已有 ACL 收紧）。
  - think 侧备选：只加文档不加 UI → 违背"设置页能改的才算是功能"的项目惯例，放弃。
- **生效与重启**：think 配置**下次唤醒即生效**（桥接每轮读 `cfg.socialV2.think`）；设置页字段要**重启 DSH** 才出现（client.js 是打包进插件 bundle 的）；令牌对齐在**桥接启动时**执行。

## 修法

- 改了什么（关键片段）：
  - `plugins/surfcore/lib/client.js`：`QQ_FIELDS` 新增「思考与读法」分组（挂在「人格与提示」分类下），三个字段：
    ```js
    F("socialV2.think.enabled", "启用思维链式读法", "默认开。…", "switch"),
    F("socialV2.think.style", "读法风格", "auto=按人格卡自动判断…", "select", { options: [["auto", "auto（跟随人格卡）"], ["brief", "brief（中性 · 最短）"], ["chatty", "chatty（口语 · 可接梗）"], ["dry", "dry（冷淡 · 只说最有用那句）"]] }),
    F("socialV2.think.maxPoints", "最多记几个要点", "2–5；越大越细，也越费 token", "number", { min: 2, max: 5 }),
    ```
    并导出 `QQ_ADV_CATEGORIES`（`exports.QQ_ADV_CATEGORIES = QQ_ADV_CATEGORIES`），让契约测试能断言"分组确实挂进了分类"。
  - `src/bridge.js`：`POST /api/socialV2/config` 把 `think` 加进子对象类型校验白名单，并用运行时同一个归一化函数收口：`if (body.think !== undefined) merged.think = normalizeThinkConfig(merged.think);`（`normalizeThinkConfig` 从 `./think.js` 一并导入）。
  - `src/bridge.js` `startConsoleServer()`：`tokenValid` 时把 `state/console-token` 写成同一个值，不一致就重写并记一行日志。
  - `plugins/surfcore/scripts/test-client-contract.mjs`：新增 3 组断言（分组存在、三个路径精确、分类挂载、风格选项正好四个值）。
  - 运行时数据：用 `POST /api/socialV2/config` 把 `socialV2.think = {enabled:true, style:"auto", maxPoints:3}` 显式写进 `config.json`（否则 UI 上开关是空白，看着像"关着"而实际开着）；`state/console-token` 对齐成 32 位生效令牌。
- 为什么选这个方案（有没有更简单的？为什么没选）：最简单是"只加三行字段"，但那样保存时 style 拼错 / maxPoints 传字符串会原样进文件，运行时再默默夹回默认值——**用户改了却看不到反馈**。所以在桥接保存口加一层归一化，写盘的就是真正生效的值。
- 回滚方式：`git revert` 该提交（三处代码 + 测试）；`config.json` 里的 `socialV2.think` 删掉即回到"缺省即开"。

## 验证

- 自动化：`node scripts/test-audit.mjs` → **`Audit suite: 153/153 scripts passed.`**（exit=0）；`plugins/surfcore/scripts/test-client-contract.mjs` → `client contract tests OK`；`scripts/test-think.mjs` → 10 项通过；`scripts/test-favor.mjs`、`scripts/test-model-api.mjs` 无回归。
- 失败路径：契约测试在"分组没挂分类"时报 `「思考与读法」要挂在「人格与提示」分类下，否则设置页看不到`；风格选项写错时报 `读法风格下拉必须正好是 normalizeThinkConfig 认的四个值`。
- 手工/集成验证（贴关键输出）：
  ```
  POST /api/socialV2/config {"think":{"enabled":true,"style":"auto","maxPoints":3}} → ok:true
  config.json 里的 think → {"enabled":true,"style":"auto","maxPoints":3}
  config token len: 32 prefix: fca18c1c
  state  before len: 48 prefix: cfb3adb7
  state  after  len: 32 match: true
  ```
- 没验证到的部分（老实写）：**设置页的实际渲染没跑**（`scripts/test-console-ui.mjs` 需要 Playwright，本机未安装，脚本直接 `Error: Playwright not found`），目前只有静态契约 + 字段路径正确性。控件是否在「人格与提示」分类里显示、保存后是否回读到新值，要等重启 DSH 后人工点一遍。

## 遗留 / 后续

- 需要补的测试：能跑 Playwright 的环境下把「思考与读法」卡片纳入 UI 冒烟（打开分组 → 切换 switch → 保存 → 重读配置断言）。
- 需要改的文档：`docs/guides/RELATIONSHIP.md` 之外，think 目前只在 `docs/cases/2026-11-02-think.md` 有记录；设置页有入口后可以在那里补一句「现在可以在设置页关掉」。
