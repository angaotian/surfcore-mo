# 出处与本地定制说明（SurfCore 0.8.9 · angaotian fork）

## 一句话

本仓库是 **[Mieksido/surfcore](https://github.com/Mieksido/surfcore) 的 fork**，基线为上游 **v0.8.9**（上游 `main` 头 `0ce8580`），
在其之上保留了一套本地追加功能。**上游原版 v0.8.9 里没有这些追加功能**；想看纯上游请直接去上游仓库。

- 上游作者 / 版权：`Mieksido`
- 本 fork 维护者：`angaotian`（仓库内 `user.name` / `user.email` 已配置为该账号）
- 许可：沿用上游 MIT，不额外附加限制
- 合并提交带脚注：`上游来源: Mieksido/surfcore（v0.8.4 → v0.8.9）；本地自定义与冲突取舍由 angaotian 完成。`

## 怎么自己核对出处

```bash
git remote -v                 # origin 指向上游（经代理），mine 指向本 fork
git log --author=angaotian    # 本地 9 个自定义提交
git diff --stat 0ce8580 HEAD  # 相对上游 v0.8.9 的全部差异（65 文件 / +11314 / -3460）
```

## 本地新增的文件（上游没有）

| 文件 | 作用 |
| --- | --- |
| `src/favor.js` | 关系系统：好感 + 亲密两个 0–100 轴、阶段、确定性打分 |
| `src/think.js` | 思维链式读法：先「要点 → 总体判断 → 未决问题」再回复 |
| `src/outreach-gate.js` | 主动开口闸门：判断能不能出声，并记账上次出声有没有人接 |
| `src/meme-pack.js` / `src/meme-pack-import.js` | 表情包管理器，兼容 AstroBot `meme_manager` 目录格式 |
| `scripts/test-{favor,think,outreach-gate,meme-pack,meme-pack-import}.mjs` | 上面四个模块的单测 |
| `plugins/surfcore/scripts/test-{favor-api,model-api}.mjs` | 插件侧接口契约测试 |
| `docs/guides/RELATIONSHIP.md` | 关系系统的设计说明 |
| `docs/cases/2026-11-02-{favor,think,meme-pack,sticker-sources,anysearch}.md`<br>`docs/cases/2026-11-08-*.md` | 对应案例记录（现象 / 根因 / 修法 / 验证 / 遗留） |
| `start-all.ps1`、`启动小鲸鱼.bat` | 一键启动脚本（本机习惯的启动方式） |
| `pnpm-lock.yaml` | 用 DSH 自带 pnpm 安装时生成的锁文件 |

## 本地改过的上游文件（主要）

| 文件 | 改了什么 |
| --- | --- |
| `src/bridge.js` | 接入 favor / think / outreach / meme-pack / Anysearch；`POST /api/dsh/model` 去重并保留宽松版；`/api/dsh/model` 同时回扁平 `providers` 与嵌套 `providerGroups`；图片能力提示按 `socialV2.vision.imageInput` 档位分支 |
| `plugins/surfcore/lib/client.js` | 设置页新增「思考与读法」分组、`visionImageInput` 生效档位显示、关系卡片字段 |
| `plugins/surfcore/lib/index.js` | 新增 `${API_PREFIX}/favor`（只读）与 `${API_PREFIX}/sticker-pack/import` |
| `src/web-search.js` | `auto` 改成四跳：Anysearch → DeepSeek Search API → DeepSeek 模型轮次 → Bing |
| `src/mcp-snowluma-safe.js` | 安全版 QQ MCP server：只暴露聊天所需动作子集，发送前强制校验白名单 |
| `public/console.html` | 独立控制台读 `providerGroups`（嵌套），而非扁平 `providers` |
| `src/sticker-lib.js`、`src/sticker-semantics.js` | 表情/贴纸来源与语义相关调整 |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 保留本地「17【唱歌】、18【提问分类】」等条目，第 16 条改用上游新文案 |

## 上游 v0.8.9 的能力（本 fork 全部保留）

向量记忆全链路（本地/云端 embedding，见 `src/vector-memory.js`、`src/embedding-packs.js`）、
会话滚动（`src/session-rollover.js`）、唤醒过滤/批处理（`src/wake-filter.js`、`src/wake-batch.js`）、
出站队列（`src/outbox.js`）、跟随 DSH 默认模型（`src/dsh-model-follow.js`）、
更新进度与 ABA 防护、记忆页双 Tab 等。这些文件本次合并未改写，只做接线。

> 具体条目以上游 CHANGELOG 为准；本文件不代理上游版本原子。

## 合并方式（给以后升级用）

上游 v0.8.4 → v0.8.9 用的是**三方合并**（merge-base `bbec146`），14 个冲突文件，
**没有**做 rebase。取舍记录在 [`docs/cases/2026-11-08-merge-upstream-0.8.9.md`](cases/2026-11-08-merge-upstream-0.8.9.md)。
下次上游再发版，建议同样做法：先保住本地功能，再逐块解冲突，不要 `git rebase`。
