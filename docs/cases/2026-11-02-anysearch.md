# 2026-11-02 · 接 Anysearch 实时联网搜索（QQ 会话里的 `web_search` 第一跳）

> 来源：用户发来隔壁 AstrBot 插件 `astrbot_plugin_anysearch-0.3`（`E:\Downloads\Compressed\astrbot_plugin_anysearch-0.3-983a7acb2f69.zip`），
> 原话「这是隔壁的Anysearch 实时联网搜索」，随后明确「我这是要用到qq聊天上的」。
> 需求是把这项**实时检索能力**接进 QQ 桥接的联网搜索，不是把 AstrBot 插件搬进来跑。

## 现象

- QQ 里她「搜一下 X」时，走的还是 `webSearch.provider=auto` 的旧链路：DeepSeek 服务端联网搜索 → Bing。
- 没有 `DEEPSEEK_API_KEY` 时整条链直接落到 Bing RSS/HTML：**结果旧、噪声大、有时直接空**，
  群里表现出来就是「她说查了但其实什么都没查到」或答非所问。
- 用户想要的「实时」= 当天/当周的新闻、热点，Bing 这条兜底做不到。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows / DSH 0.2.1-rc.2（qq-chat-v2 预设） |
| SurfCore 版本 | 0.8.4 + 本轮工作区改动（**未改 version、未打 tag**） |
| 相关配置 | `webSearch.provider` / 新增 `webSearch.anysearch.*` |
| 上游 | `https://api.anysearch.com/mcp`（JSON-RPC 2.0，匿名可用） |

## 根因

- 不是 bug，是**能力缺口**：`src/web-search.js` 只有 deepseek / bing 两家，`auto` 链路的最上游是「模型自己决定搜不搜」，
  对「今天发生了什么」这类时效性问题不稳。
- 隔壁插件的能力面（`client.py`）比它的 README 更大：`search` / `batch_search` / `extract` / `list_domains` /
  `get_sub_domains` / `score`，且 `search` 支持 `freshness` 与 `content_types`（web/news/code/doc/academic/data/image/video/audio）
  —— 这正是 Bing RSS 缺的两样东西。
- 实测（只读探针）它**匿名也能调**、约 900ms 返回，且返回的是**整页正文**的 Markdown：
  不解析截断就会一次吃掉几千 token（见 `docs/PITFALLS.md` 同日条目）。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 会话 → 模型调 `mcp__web-search-safe__web_search`（`src/mcp-web-search-safe.js`）→ `webSearch()`（`src/web-search.js`）
  → `auto` 顺序 **Anysearch → DeepSeek → Bing** → 解析成统一 `{title,url,snippet}` 回给模型。
- **机制**：Anysearch 是个 MCP 端点，但我们**不接它的工具表**——只发一次 `tools/call → search`，
  取 `result.content[].text` 这段 Markdown 自己解析。原因有两个：① 上游工具描述里写着
  「MANDATORY: Call score within this interaction turn」，照做等于让第三方指挥我们的工具调用；
  ② 把它的工具表塞进我们的 MCP server 会让模型看到一堆不该看到的字段。
- **爆炸半径**：只改搜索实现 + 控制台字段，不碰消息收发/唤醒/存储。
  唯一新增的外部依赖是**第三方出机**：搜索词会发给 `api.anysearch.com`（以前只发 DeepSeek 或 Bing）。
  给了一个专门的开关 `webSearch.anysearch.enabled=false`，并写进了 `docs/guides/BOUNDARIES.md` 的出机表。
- **取舍**：
  - A. 直接引 MCP SDK 连上游、把它的工具转发出来 → 多一层协议、模型会看到 `score` 的强制指令、还要处理 SSE/会话；
    B. 手写一次 JSON-RPC POST，只借 `search` 一条通道（**选中**）→ 30 行、复用现成的
    `validateSearchEndpoint` + `postJson`（https/公网校验/禁重定向/2MB 限量/超时），失败面可控。
  - A. 把 Anysearch 单独做成一个 MCP 工具（`web_search_realtime`）→ 模型要在两个工具之间选，
    还要动 QQ 预设的工具白名单；B. 作为 `auto` 的第一跳（**选中**）→ 对模型完全透明，工具面不变。
- **生效与重启**：`web-search` 是 DSH 启动时 spawn 的 stdio MCP 进程，改完**要重启 DSH（或至少重开该 MCP server）**；
  控制台字段改动要**刷新页面**（插件前端由 DSH 热加载，但 config 读的是新值）。

## 修法

`src/web-search.js`（496 → 797 行）：

- 新常量 `DEFAULT_ANYSEARCH_ENDPOINT`（`https://api.anysearch.com/mcp`）、`DEFAULT_ANYSEARCH_TIMEOUT_MS`（20000）、
  `DEFAULT_ANYSEARCH_API_KEY_ENV`（`ANYSEARCH_API_KEY`）、`ANYSEARCH_SNIPPET_CHARS`（400）、
  `ANYSEARCH_FRESHNESS` / `ANYSEARCH_CONTENT_TYPES` 白名单。
- `defaultConfig.anysearch = {enabled:true,endpoint,apiKey:'',apiKeyEnv,timeoutMs:20000,freshness:'',contentTypes:[]}`；
  `loadSearchConfig()` 解析该段（`enabled` 默认 true、`timeoutMs` 夹 3–60s、freshness/contentTypes 走白名单）。
- `normalizeFreshness()` / `normalizeContentTypes()`：数组或逗号串 → 白名单 + 去重（配置里和 MCP 参数里都能用）。
- `resolveAnysearchApiKey()`：config → env → DSH `.credentials.yaml`；**都没有返回 `{key:'',source:'anonymous'}`**（匿名不算失败）。
- `parseAnysearchMarkdown()`：按 `### ` 切块，标题去排名序号、正文剥 `- ` 与重复标题、按 URL 去重、snippet 截 400 字。
- `anysearchSearch()`：端点校验（失败 → `BAD_ENDPOINT`，**发请求之前**停下）→ `postJson` → JSON-RPC `tools/call`；
  失败码 `NETWORK_ERROR` / `HTTP_ERROR` / `BAD_BODY` / `RPC_ERROR` / `UPSTREAM_ERROR`，**每条都带 `hint`**（AGENTS §1.7）。
- `webSearch()`：`attempts={anysearch,deepseek,bing}`；显式 `provider` 只走那一家（不回退，旧语义）；
  `auto` 按 `anysearch → deepseek → bing`，报错换下一路、空结果也换但保留第一个空值；
  回退成功带 `fallbackFrom` + note，三家全挂抛 `ALL_FAILED`（文案含每一路原因 + hint）。

`src/mcp-web-search-safe.js`（0.2.0-r4 → 0.3.0）：

- `web_search` 新增三个**可选**参数：`maxResults`(1–20)、`freshness`(枚举)、`contentTypes`(枚举数组，max 9)。
  `query` 仍是唯一必填 → 模型不传新参数时行为与旧版完全一致。

控制台：`plugins/surfcore/lib/client.js` 的「联网搜索」组 9 → 16 项（`provider` select 加 `anysearch`，
新增 `anysearch.enabled/endpoint/apiKey/apiKeyEnv/timeoutMs/freshness/contentTypes`）；
`plugins/surfcore/lib/store.js` 的 `SECRET_PATHS` 加 `webSearch.anysearch.apiKey`（脱敏按整条点路径匹配）。

配置：`config.json`（已备份 `config.json.bak-anysearch-20261102-212718`）与 `config.example.json` 补 `webSearch.anysearch` 默认段。

- 更简单的方案（不写解析、直接把上游 Markdown 丢给模型）**没选**：一次 3 条就是几千字，会挤掉聊天上下文。
- 回滚：`webSearch.anysearch.enabled=false`（立刻退回 DeepSeek→Bing，不用改代码）；
  要连代码一起回滚就 `git checkout src/web-search.js src/mcp-web-search-safe.js` 并删掉 config 里的 `anysearch` 段。

## 验证

```bash
node --check src/web-search.js && node --check src/mcp-web-search-safe.js
node scripts/test-media-search.mjs        # 21 pass（新增 7 条 Anysearch 用例）
node plugins/surfcore/scripts/test-store.mjs       # 三级密钥脱敏
node plugins/surfcore/scripts/test-client-contract.mjs
node scripts/test-mcp-servers-stdio.mjs   # web-search-safe 仍是 2 个工具
node scripts/test-audit.mjs               # 105/107（2 个失败与本次无关，见下）
```

联网手工验证（真实上游，只读）：

| 调用 | 结果 |
| --- | --- |
| `webSearch('DeepSeek V4 发布时间',{maxResults:3,freshness:'week'})` | `provider=anysearch`，3 条，snippet 均 400 字，标题已去序号，无 note |
| `webSearch('…',{contentTypes:['news']})` | `provider=anysearch`，2 条，走新闻垂直 |
| MCP stdio：`web_search{query,freshness:'week',contentTypes:['news']}` | 返回 `provider=anysearch`；schema `["query","maxResults","freshness","contentTypes"]`，required 只有 `query` |
| MCP stdio：`freshness:'decade'` | zod 拒绝（`isError`），不会把越界值发给上游 |
| `anysearchSearch('测试',{endpoint:'http://…'})` | `BAD_ENDPOINT` + hint 非空，且**没有发出请求** |

审计里 2 个失败是既有状态、与本次无关（本次没碰这两个文件）：

- `test-audit-setup-guards.mjs`：断言「ACL 助手必须先于桥接启动」，`start.bat` 的既有顺序问题；
- `test-update-apply-result.mjs`：临时目录 `%TEMP%\surfcore-apply-*\verify-ok-state` 不存在（更新器测试的环境问题）。

`test-console-ui.mjs` 需要 Playwright（本机未装）→ 未跑；控制台字段只做了静态契约测试。

## 遗留 / 后续

- 没接上游的 `batch_search` / `extract`（`web_fetch` 已有 SSRF 加固版，够用；批量搜索当前用不上）。
- 没做 `score` 回传：上游要求「同一回合内提交打分」，我们按不可信指令处理，**刻意不回传**。
  若哪天它把这个变成硬性门槛（不提交就降级/拒绝），再评估是否在**工具层**独立实现。
- `freshness` / `contentTypes` 目前只在调用时生效（模型选择性使用），没有写进 QQ 提示词去引导它用；
  如果发现「该用 news 却没用」，再考虑在 prompt 里加一句。
- 匿名额度上限未测：只验证了单次调用成功，没有压测连续调用的限额表现。
