# 导入的表情包被同步清空（source 归一化 + 同步清理）

> 来源：2026-11-02 把桌面端 dsh-meme 的 14 个图库接进 QQ，导入大肥鱼系 5 个包后，库存从 487 条回退成 42 条。

## 现象

1. 通过 `POST /api/stickers/pack-import` 依次导入 5 个包，接口每次都返回 `added` 正确、`total` 递增（42 → 73 → 91 → 330 → 487）。
2. 约 1 分钟后 `state/stickers.json` 只剩 **42 条**（全部 `source:"manual"`），`state/bridge.log` 出现
   `[sticker] 已同步 QQ 收藏表情 0 个（本地库 42 条）`，`/api/socialV2/sticker-list` 也回到 `total:42`。
3. 导入的 445 张图还在 `state/sticker-files/<包id>/` 里，但条目没了 —— 一分钟后她发不出来。

## 环境

| 项 | 值 |
| --- | --- |
| 桥接 | `src/bridge.js`（单进程，唯一写者），控制台 `127.0.0.1:3100` |
| 表情库 | `state/stickers.json`（当时 42 条：24 大肥鱼 + 18 deepseek娘） |
| 配置 | `socialV2.sticker.syncTtlMs=60000`、`maxListCount=100` |
| QQ 账号 | 收藏表情 0 个（`fetch_custom_face_detail` 返回 `data: []`） |

## 根因

两处叠加，缺一不可：

1. `src/sticker-lib.js` 的 `normalizeStickerEntry` 只认 `manual` / `ai`，其余一律压成 `qq`：

   ```js
   source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq')
   ```

   导入模块写的 `source: 'pack'` 过了这一层就变成 `qq`。

2. `mergeStickerLibrary` 的清理规则只保留「QQ 端还在」的 `qq` 条目：

   ```js
   return out.filter((e) => !complete || e.source !== 'qq' || fetchedIds.has(e.id));
   ```

   QQ 收藏为 0 时 `complete = fetched.length < count = true`，`fetchedIds` 为空 →
   所有被压成 `qq` 的导入条目都被当成「QQ 端已删除」清掉，然后 `saveStickerStoreSafe()` 落盘。

**为什么文件里看着还是 `pack`**：`saveStickerStore` 直接序列化内存数组，而内存数组是
`ensureStickerIndex`（内部走归一化）处理过的 —— 落盘时机不同，就会出现「文件里是 pack、内存里是 qq」的错觉。

## 完整逻辑

- **链路**：`POST /api/stickers/pack-import` → `importMemePackDir(dir)` → `importPackDir`（复制图片、造条目、`source:'pack'`）→
  `onSave(nextEntries)` → `stickerEntries = nextEntries` → `ensureStickerIndex`（归一化）→ `saveStickerStoreSafe()`。
  之后任意一次 `syncStickerLibrary()`（发图、列表情、60 秒 TTL 到期都会触发）→ `mergeStickerLibrary` 清理 → 落盘。
- **机制**：QQ 收藏表情是「远端权威」，本地只在 `source !== 'qq'` 时豁免清理。来源字段被压平，豁免就不生效。
- **爆炸半径**：所有整包导入 / 自搜图入库的条目，都会在下一次同步时消失；手工 42 条不受影响，所以现象像「只有新导入的没了」。
- **取舍**：
  - 方案 A（采纳）：把 `pack` / `agent` 加进合法来源集合，同步只清理 `qq`。改动 2 行，语义最直白。
  - 方案 B（否决）：同步时先 `loadStickerStore` 重读磁盘再合并。能兜住「别的进程写文件」，但会把并发写入的中间态带进来，
    也掩盖了「唯一写者」被绕开的真问题；而且每次同步都读 350KB+ 文件，收益不划算。
- **生效与重启**：`src/sticker-lib.js` 是桥接进程内的模块，改完要重启桥接（`PITFALLS #25`：热重载不清 ESM 缓存）。

## 修法

- `src/sticker-lib.js`：新增 `export const STICKER_SOURCES = new Set(['qq','manual','ai','pack','agent'])`，
  `normalizeStickerEntry` 改为 `source: STICKER_SOURCES.has(entry.source) ? entry.source : 'qq'`。
- 清理规则不动（`e.source !== 'qq'` 本来就豁免非 qq 条目，只是以前拿不到 `pack`）。
- `scripts/test-meme-pack-import.mjs`：新增回归用例「导入的 pack 条目必须保住 source=pack，不能被『QQ 端已删除』的同步清理带走」——
  造一个包导入 → 归一化 → `mergeStickerLibrary(normalized, [], { complete: true })` → 断言 pack 条目仍在、`qq` 条目被清。

## 验证

```bash
node scripts/test-meme-pack-import.mjs   # 7 pass（含新回归）
node scripts/test-stickers.mjs           # 71 通过
node scripts/test-meme-pack.mjs          # 10 pass
```

真机：

1. 重启桥接后重新导入 `dafeiyu-learned` / `dafeiyu-2-emotes` / `dafeiyu-blue-emotes` / `pack-mvc2p5cv`，
   接口返回 `total:487`。
2. `POST /api/stickers/sync`（强制同步，QQ 收藏仍是 0）→ `{"ok":true,"total":487}`，`state/stickers.json` 仍是
   `{"manual":42,"pack":445}` —— 导入条目活过了清理。
3. `POST /api/socialV2/send-sticker` 用 `#74` / `#313` / `#470` 三张新包表情发到 `private:82071738`，全部 200。

## 已知边界

- 来源集合是**白名单**：以后再加来源（比如 `import`、`vlm`）必须同时加进 `STICKER_SOURCES`，否则又被压成 `qq` 并遭清理。
- 手工改 `state/stickers.json` 仍然不安全：桥接内存不回读文件，下一次同步会按内存覆盖（这就是「导入要走接口」的原因）。
- 同步清理依赖 `complete` 判定（`fetched.length < count`）；QQ 收藏正好 100 条时会被当成「不完整」，此时不清理（保守，正确）。

## 追加（2026-11-02 21:10）：导入后情绪全是 neutral

修好上面那条、把 14 个 dsh-meme 图库全导进来（1103 张）之后，发现第二个问题：**1145 条里 1079 条是 `neutral`**。

- 现象：`content` 是 `angry` / `daily` / `sleep` 这种英文，`keywords` 也是英文单词；`qq_send_sticker` 发得出去，但「按情绪挑图」永远挑不中它们。
- 根因：dsh-meme 的图库目录用的是它自己的分类词（`angry/happy/daily/sleep/surprised/like/sigh/givemoney/work/morning/baka/color/cpu/fool/meow/reply/speechless`），
  而 `stickerDraftFromMeme` 直接拿目录名去 `detectEmotions()`（中文词表），英文一个都不命中，于是全落 `neutral`。
- 修法：`src/meme-pack.js` 新增 `categoryEmotionOf(category)` + `CATEGORY_ALIASES` / `CATEGORY_LABELS`：
  先按 SurfCore 的 20 类直接归一化（`生气`、`angry` 都行），再查别名表（`sleep→tired`、`confused/sigh/cpu→speechless`、`baka/fool→tease`、`meow/like→cute`、`morning→happy`、`work→tired`、`daily/see/color/reply/givemoney→neutral`）；
  没有 caption 时 `content` 用中文标签（`生气`、`日常`、`上班`），`keywords` 同时保留英文目录名和中文标签。
- 验证：全库重导后情绪分布变成 `happy 265 / neutral 246 / speechless 154 / angry 147 / sad 126 / shy 85 / tired 51 / cute 32 / surprise 23 / …`；
  prompt 里的表情清单仍是 1008 字符（60 张，按情绪分组），没有因为库变大而膨胀。
- 重导流程（记住顺序）：`stop()` 桥接 → 备份 `state/stickers.json` → 删掉 `source:'pack'` 条目 → `start()` 桥接 → 逐个调 `POST /api/stickers/pack-import`。
  直接在桥接运行时改文件会被内存写回。
- 边界：`dafeiyu-001`（内置包，`node_modules/dsh-meme/memes`）没有 `manifest.json`，`pack-import` 会返回 `PACK_MANIFEST_UNREADABLE`；
  那 24 张本来就以 `manual` 条目在库里，不需要导。

## 追加（2026-11-02 21:40）：把库备份进 QQ 收藏表情

目标：硬盘格式化也不丢图 —— 把本地图上传进 QQ 账号的收藏表情（`add_custom_face`，`base64://` 上传）。

- 上限实测：**QQ 收藏 1000 张**（第 1001 张开始 `add_custom_face` 报错）；`fetch_custom_face_detail` **单次最多 300 条**（`count:999` → `OIDB error 155`），所以同步永远只看到最近 300 张。
- 去重：32×32 灰度 RMS 距离 ≤ 0.05 判为同一张（1127 张里合掉 73 张），再按图包价值排序截到 1000。用 0.10 会把「同姿势换手持物」的变体也合并（拼图肉眼验过，已弃用）。
- 结果：收藏 1000 张（满），本地库仍 1145 条（多出的 145 张是近重复 + 低优先图包 + 18 张外链图），本地是超集。
- 认领：上传成功后把 `resId` 写成 QQ 的 `emoji_id`；`mergeStickerLibrary` 按 `resId` 认领，同步后条目数不变（1145），URL 更新成 QQ CDN（`https://p.qpic.cn/qq_expression/...`）。
- 验证：`POST /api/stickers/sync` → `total 1145`；`send-sticker` 用 `local-dafeiyu-shengqi` 与 `#1` 发送均 200；QQ CDN 直链 200 / image/jpeg / 39446B。
- 附带修掉的老问题：QQ 用 `emoji_id` 当 id，同步会把同一张图插成第二条 —— 这次一并修了（`scripts/test-stickers.mjs` 加回归用例，74 通过）。

## 追加（2026-11-02 21:50）：收藏上限不是 1000 而是「能用 500」

- **现象**：传满 1000 张之后发现**超过 500 张用不了**（客户端只认前 500）。用户要求精简到 500。
- **修法**：按图包价值排序（手绘 24 > 学图 31 > GPT生 17 > 蓝色动态 141 > 大肥鱼2.0 218 > 泡泡 69）留前 500，
  其余调 `delete_custom_face` 删除（这次删了 502 张，每张约 0.25~0.5s）。
- **删完必须「撤回认领」**：本地条目的 `resId` 还指着已删的 `emoji_id`、`url` 还指着已删的 CDN 地址。
  停桥接 → 把 `resId` 还原成自己的 id、`url` 按 md5 还原成本地 `file://` 路径 → 启桥接 → 同步。否则那些表情永远发不出去。
- **验证**：同步后 `total 1145` 不变、`claimed` 494；`send-sticker` 分别用「已认领」和「只在本地」的条目各发一张，都 200。
- **教训**：QQ 的「本来数量」和「能用数量」是两个数；维护上限要按 **能用** 的那个来定，别按能传进去的那个。

## 追加（2026-11-02 22:05）：发图优先本地副本

- **需求**：用户 m03412「优先发本地的」——同步会把 `url` 改写成 QQ CDN，发图就变成每次都要联网下载一遍。
- **做法**：条目新增 `localUrl` 字段（`file://` 绝对路径）。`sendStickerV2` 先看 `localUrl` 指向的文件是否真存在，
  存在就直接 `fs.readFileSync` 转 `base64://`；不存在或没有 `localUrl` 才走原来的 `url`。
  `mergeStickerLibrary` 只更新 `url`、保留 `localUrl`；归一化时 `url` 是 `file://` 也会顺手写进 `localUrl`。
- **验证（关键）**：造了一条「`url` 指向不存在的 CDN（`https://p.qpic.cn/__definitely_dead__/0`）+ `localUrl` 指向真实文件」的探针，
  `POST /api/socialV2/send-sticker` 仍 **200 发出** —— 证明走的是本地文件而不是网络。探针用完即删。
  另测已认领（`local-dafeiyu-shengqi`）、按编号（`#267`）、纯本地（`local-pack-dafeiyu-2-emotes-confused-gethit-bits`）三条都 200。
- **踩坑**：`localUrl` 一开始写成 `file:///state\sticker-files\...`（相对路径拼的），`fileURLToPath` 解析后指到盘符根，
  1127 条全指错。**必须 `path.resolve` 后用 `pathToFileURL`**。回填时按 md5 重建，`repaired` 式的校验不能只看「有值」。
- **数据**：库 1145 条，其中 1127 条有本地副本（18 条是 jsdelivr 外链、本来就没有本地文件），100 条「已认领」的也能走本地。
