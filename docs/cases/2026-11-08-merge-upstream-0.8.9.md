# 2026-11-08 合并上游 v0.8.9（保留本地自定义）

## 现象

- 用户看到什么（原话尽量保留）：「github上SurfCore已经0.8.9版本了，我的是0.8.4，但是我自己加了不少东西」
- 复现步骤：`git status --short --branch` → `## main...origin/main [ahead 1, behind 5]`；本地 28 个已修改文件 + 21 个未跟踪文件（本地专有功能）
- 影响面：升级失败会丢本地功能（好感度 favor、表情包资源库 meme-pack、内心戏 think、主动发言闸门 outreach-gate、Anysearch 检索、独立控制台 model 面板）；不涉及用户数据/密钥，代码可回滚

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 10 + DSH 桌面版 |
| SurfCore 版本 | 本地 0.8.4（+本地自定义） → 上游 0.8.9 |
| 安装方式 | git（插件以 junction 挂到 `~/.dsh/plugins/surfcore`） |
| 其它相关版本 | node 运行时 v24.21.0（`engines.node >=22.13.0`）；PATH 上的 node v20.19.5 不满足 |

## 根因

- 代码位置：`git merge-base HEAD origin/main` = `bbec146` = v0.8.4 release commit；本地 HEAD `d1b8082`（Anysearch 提交）在其之上 → 干净的 3 方合并基础
- 问题链条：上游 v0.8.4→v0.8.9 改了 352 个文件（+36620/-4199），其中 `src/bridge.js`、`plugins/surfcore/lib/client.js`、`scripts/audit-bridge-harness.mjs` 恰好是本地改动最密集的文件 → 直接 merge 必然冲突
- 为什么之前没发现：本地长期在 0.8.4 上叠加自定义，没有及时跟进上游

## 完整逻辑（给用户看的那一遍）

- **链路**：`src/bridge.js`（桥接进程，读写 `~/.dsh/surfcore/state`）→ 插件 `plugins/surfcore/lib/index.js`（DSH 插件侧 API）→ `plugins/surfcore/lib/client.js`（插件控制台前端请求）。上游 0.8.9 在桥接里新增向量记忆（`src/vector-memory.js`、`src/embedding-packs.js`）、会话滚动（`src/session-rollover.js`）、模型目录（`src/model-options.js`）、outbox/唤醒过滤等模块
- **机制**：合并冲突的本质是「同一处被两侧改了」。本地改的是功能（favor/think/表情包/Anysearch），上游改的是架构（模型目录改成分层结构、语音状态改为按工具探测、`providers` 改成扁平 id 数组）；措辞与字段契约冲突比逻辑冲突多
- **爆炸半径**：桥接进程 1 个、读 `state/` 的所有功能；`providers` 契约变了会同时影响插件卡片和控制台；静默错误 = 3（功能不报错但失效），不碰密钥、不额外花钱
- **取舍**：
  - A `git rebase` 本地提交到上游：会被打散成 1 个提交反复解冲突，且本地提交语义丢失 → 否
  - B（选）`git merge --no-ff origin/main`：3 方合并，merge-base 干净，冲突集中在 14 个文件；先在隔离副本预演、跑测试、跑基线对照，确认后再落到真实仓库 → 慢但可验证、可回滚
  - C 直接覆盖成上游 0.8.9 再手抄本地功能 → 等于重写，风险最高 → 否
- **生效与重启**：`src/bridge.js`、`plugins/surfcore/**` 改动要重启桥接进程（`start-all.ps1` / `启动小鲸鱼.bat`）+ DSH 插件重载才生效；本次落地时机器上没有 node 进程（桥接未运行），所以不打断在线服务

## 修法

- 先在 `E:\deepseek-zgq\_tmp\sc-rehearsal\surfcore`（robocopy 副本，排除 node_modules）预演：提交 WIP `53c4724` → `git merge --no-commit --no-ff origin/main` → 14 个冲突文件 / 30 个冲突块
- 冲突处理原则：**本地功能优先保留，上游的架构与措辞跟进**
  - `src/bridge.js`（9 块）：`POST /api/dsh/model` 保留本地宽松版并删除上游重复路由（83 行），把上游的 `catalogChoices`/`findCatalogModel`/`price`/`imageInput` 字段补进本地版；响应同时给 `providers`（扁平 id，上游插件用）与 `providerGroups`（嵌套，本地控制台用）
  - `plugins/surfcore/lib/client.js`（5 块）：跟随上游 `providers` 扁平化，控制台改读 `providerGroups`
  - `src/web-search.js`（3 块）：auto 链路变四跳 `Anysearch → DeepSeek Search API → DeepSeek 模型轮次 → Bing`，保留本地 cacheKey（含 freshness/contentTypes）与空结果续跳
  - `src/character-persona.js`（1 块）：取上游（补上 tone/full 层分支），保留本地注释说明「缺分支会导致核心注入两遍」
  - `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（1 块）：保留本地 17【唱歌】、18【提问分类】，第 16 条【发语音】换成上游措辞（以工具返回 `VOICE_DISABLED`/`VOICE_TOOL_DISABLED` 为准，不再写死"默认关闭"）
  - docs / `package-lock.json` / `scripts/audit-bridge-harness.mjs` / `test-client-contract.mjs`：并集
- 生成物不手工合并：`plugins/surfcore/presets/qq-chat-v2.patch.yml` 由 `node scripts/build-agent-preset-patches.mjs` 从 `agent.cordis.yml` 重新生成
- 落地真实仓库 `E:\DSH-Data\surfcore`：备份分支 `backup/pre-0.8.9-merge` → 本地改动按明确路径 `git add` 后提交 WIP `e792677`（50 文件 +6873/-59）→ `git merge --no-commit --no-ff origin/main` → 用预演副本的解析结果覆盖 17 个文件（14 冲突 + 3 个 auto-merge 后又手改的）→ 逐文件 sha1 校验与预演副本完全一致
- 回滚方式：`git reset --hard backup/pre-0.8.9-merge`（或 `git merge --abort` 若未提交）；补丁另存 `E:\deepseek-zgq\_tmp\real-local-dirty.patch`

## 验证

- 自动化（真实仓库，node v24.21.0）：`test-favor` / `test-think` / `test-outreach-gate` / `test-meme-pack` / `test-meme-pack-import` / `test-agent-preset-patches` / `test-voice-prompt-fix` / `test-media-search` / `test-audit-bridge` / 插件 `test-favor-api` / `test-model-api` → **11/11 通过**
- `node --check` 覆盖 `src/bridge.js`、`src/web-search.js`、`src/character-persona.js`、`src/vector-memory.js`、`src/embedding-packs.js`、`plugins/surfcore/lib/{client,index}.js`、`scripts/audit-bridge-harness.mjs` 等 11 个文件 → 全部通过
- 全仓库冲突标记扫描（`^<<<<<<< ` / `^>>>>>>> `）→ 0
- 预演副本 `npm run test:audit`：**144/153**（合并前基线同一沙箱 97/107）→ 剩余 9 个失败逐条定性：
  - 基线就失败：`test-audit-setup`、`test-audit-setup-guards`、`test-qq-model-view`、`test-bili-state-paths`、`test-release-manifest`、`test-update-apply-result`、`test-update-version-fallback`
  - 沙箱限制（`spawnSync` EPERM，禁止子进程管道）：`test-bili-prefix-config`、`test-release-manifest-verify`
  - 合并后反超通过的：`test-stickers`、`test-agent-preset-patches`、`test-voice-pack-import`
- 插件侧 `plugins/surfcore/scripts/test-*.mjs`：28 通过 / 10 失败，10 个失败与合并前基线**完全相同**（pet/updates 类）
- 没验证到的部分：真实 QQ 在线联调（桥接未启动）、向量记忆云端 embedding 真调用（需密钥与配额）、`test-audit` 里 9 个环境相关的失败未在干净机器复测

## 遗留 / 后续

- 需要补的测试：`test-media-search` 的四跳断言已更新为 `order.push('deepseek-api', 'deepseek', 'bing')`；`test-audit-bridge` 改读 `providerGroups` —— 建议补一条「`providers` 必须是扁平字符串数组」的正向断言，防止上游再改回去
- 需要改的文档：`docs/guides/MODULE-BRIDGE.md` 已并集更新；向量记忆相关文档是上游新增（`docs/guides/VECTOR_MEMORY.md`、`docs/guides/EMBEDDING_PACKS.md`），本地的 `docs/guides/RELATIONSHIP.md` 未受影响
- 待办：真机启动桥接后跑一次 `npm run test:regressions`，并确认控制台模型面板、好感度页、表情包页三处 UI 正常
