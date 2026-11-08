# 强制「支持图片输入」后仍在提示「按文字兜底」——图片能力提示与实际生效值脱节

## 现象

- 用户看到什么（原话尽量保留）：
  - 用户在设置页 QQ 页的「模型与思考强度」卡片上画了**红框**，框住一条 toast：`⚠️ 模型目录没有声明图片能力：未知，按文字兜底更安全`，并说「**我要识图**」「红框子是我想让你注意到的标记」。
  - 也就是说：用户想要 QQ 侧能看图，但卡片一直在暗示"图片只能走文字兜底"。
- 复现步骤：
  1. 模型选一个目录里没有 modality 声明的第三方模型（本例 `fox-chat / deepseek-v4.1-flash-1017`）。
  2. 点保存 → toast 弹「模型目录没有声明图片能力：未知，按文字兜底更安全」。
  3. 去「工具与媒体 → 图片能力」把「模型图片输入」改成「支持图片输入」并保存。
  4. 回到模型卡片再保存一次 → **同一条"按文字兜底"的 toast 又弹一遍**，卡片的图片行也还写着「图片能力未知」。
- 影响面：不丢数据、不报错。但用户会误判"设置了没用"，从而放弃识图能力；实际 `auto` 档在"非默认 provider/model 且目录无声明"时是**真的会退化成 false**，所以这句提示在 `auto` 下是对的、在强制档位下是错的。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 桌面版（runtime node v24.21.0） |
| SurfCore 版本 | 0.8.9（本地定制版） |
| 安装方式 | junction（`~/.dsh/plugins/surfcore` → `E:\DSH-Data\surfcore\plugins\surfcore`） |
| 其它相关版本 | 桥接运行中（consolePort 3100），模型 `fox-chat/deepseek-v4.1-flash-1017` |

## 根因

- 代码位置（文件:行）：
  - `src/bridge.js:11002` `detectImageInput(provider, model)`：`mode === 'true'` 直接 `return true`；`'false'` 直接 `return false`；只有 `auto` 才查目录 `inputModalities`。
  - `src/bridge.js:5986-5988`（`POST /api/dsh/model` 的 warnings）：**只看目录**，不看 `cfg.socialV2.vision.imageInput`：
    ```js
    if (picked?.imageInput === false) warnings.push('这个模型未声明图片输入：…');
    if (picked && picked.imageInput == null) warnings.push('模型目录没有声明图片能力：未知，按文字兜底更安全');
    ```
  - `src/bridge.js:6000` 响应 `imageInput: picked?.imageInput ?? null` —— 回的是**目录值**，不是**生效值**。
  - `plugins/surfcore/lib/client.js:3316` 卡片图片行 `imageText` 同样只读 `current?.imageInput`（目录值）。
- 问题链条：图片能力有"目录声明"和"用户强制"两个来源，但**提示与展示只读了目录那一份**。于是强制成「支持」之后，运行时（`detectImageInput` 走 `true` 分支）已经在发 image block，而 UI 还在说"按文字兜底"——两边自相矛盾。`auto` 档下这段提示是对的（`:11023` 对非默认模型确实会把 `null` 收敛成 `false`），所以问题只在强制档位下暴露。
- 为什么之前没发现：`scripts/test-model-api.mjs` 只断言 `{ok, provider, model, reasoningEffort, effortAdjusted, catalogChecked}` 这些字段，**从不断言 warnings 内容**；UI 侧也没有针对"强制档位"的契约测试。

## 完整逻辑（给用户看的那一遍）

- **链路**：设置页选模型 → `POST /api/dsh/model` 写 `config.json` 的 `dsh.*` 并递增 `modelSelectionEpoch` → 下一条 QQ 消息 `ensureChatModel()` 重新 `selectModel` → 图片路径（`getImages` / 表情 / 图片消息）先问 `detectImageInput()`：`true` 发 image block，`false` 只发文字标签。
- **机制**：图片能力是**三档开关**（`auto` / `true` / `false`），目录声明只是 `auto` 档的**输入之一**，不是唯一真相。任何"告诉用户现在能不能看图"的地方都必须回答**生效值**，而不是目录值。
- **爆炸半径**：进程 1（桥接）× 读者 2（toast、卡片文案）× 静默=3 → 中等：不会报错，但会让人放弃功能。不碰数据、不碰密钥、不花钱。
- **取舍**：
  - 备选 A：让用户改 DSH 模型目录、把 `inputModalities` 补上 → 目录是 DSH 侧数据，第三方模型根本不在里面，改不了。
  - 备选 B（选它）：在桥接里按 `vision.imageInput` 分支给提示，并把生效值一起发出去（`imageInput` 回生效值 + 新增 `visionImageInput` 档位）。成本极低，且把"谁是真相"这件事写进代码。
  - 备选 C：直接删掉这条警告 → 会丢掉 `auto` 档下"你可能看不了图"的有效提醒，放弃。
- **生效与重启**：`vision.imageInput` 走 `POST /api/socialV2/config` 会同步更新内存 `cfg`（`src/bridge.js:6546` `cfg.socialV2 = { ...cfg.socialV2, ...merged }`），**识图立刻生效，不用重启**；但提示文案的代码改动要等**桥接重启**才生效。

## 修法

- 改了什么（关键片段）：
  - `src/bridge.js` `POST /api/dsh/model`：
    ```js
    const visionMode = String(cfg.socialV2?.vision?.imageInput ?? 'auto').toLowerCase();
    const effectiveImageInput = visionMode === 'true' ? true
      : visionMode === 'false' ? false
        : (picked?.imageInput ?? null);
    if (visionMode === 'true') {
      if (picked?.imageInput !== true) warnings.push('已在「图片能力」里强制按「支持图片输入」处理：目录没有声明这个模型，若它其实不支持，QQ 图片会报错或被忽略');
    } else if (visionMode === 'false') {
      warnings.push('已在「图片能力」里强制关闭图片输入：QQ 图片/表情只发文字标签');
    } else {
      if (picked?.imageInput === false) warnings.push('这个模型未声明图片输入：QQ 图片/表情将只发文字标签，不会发 image block');
      if (picked && picked.imageInput == null) warnings.push('模型目录没有声明图片能力：未知，按文字兜底更安全；确认它能看图就去「图片能力」里选「支持图片输入」');
    }
    ```
    响应 `imageInput` 改成 `effectiveImageInput`，并新增 `visionImageInput: visionMode`。
  - `src/bridge.js` `GET /api/dsh/model` 也回 `visionImageInput`，让卡片能显示生效档位。
  - `plugins/surfcore/lib/client.js` 卡片图片行：
    ```js
    const visionMode = String(info?.visionImageInput ?? "auto").toLowerCase();
    const imageText = visionMode === "true" ? "已强制支持图片"
      : visionMode === "false" ? "已强制仅文本"
        : current?.imageInput === true ? "支持图片" : current?.imageInput === false ? "仅文本（图片走文字兜底）" : "图片能力未知";
    ```
- 为什么选这个方案（有没有更简单的？为什么没选）：最简单是"删掉警告"，但那会把 `auto` 档下真实存在的"你可能看不了图"提示一起删掉；改目录也不可行（第三方模型不在 DSH 目录里）。按档位分支既保留 `auto` 的提醒，又让强制档位说实话。
- 回滚方式：`git revert` 该提交；或把 `socialV2.vision.imageInput` 改回 `auto`（运行时行为回到"查目录"）。

## 验证

- 自动化：`node scripts/test-audit.mjs` → `Audit suite: 153/153 scripts passed.`；`plugins/surfcore/scripts/test-client-contract.mjs` → `client contract tests OK`；`plugins/surfcore/scripts/test-model-api.mjs` → `model api tests OK`。
- 失败路径：`auto` 档下目录无声明时仍会弹「未知，按文字兜底更安全」+「确认它能看图就去…选支持」；`false` 档下弹「已在「图片能力」里强制关闭」；`true` 档下弹「已在「图片能力」里强制按「支持图片输入」处理」。
- 手工/集成验证（贴关键输出）：
  ```
  POST /api/socialV2/config {"vision":{"imageInput":"true"}} → ok:true
  config.json vision.imageInput = true
  ```
  用户侧证据：同一 relay 通道（`deepseek-v4.1-flash-1017`）在本会话里**成功读取了用户贴的设置页截图**（1923×1234 PNG），说明该模型确实能接收图像块——这是"目录没声明 ≠ 不支持"的直接反例。
- 没验证到的部分（老实写）：**没有真的在 QQ 里发图测试**（需要用户起桥接并让机器人醒着）；桥接未重启，所以新提示文案要等下次重启才看得到（配置本身已即时生效）。

## 遗留 / 后续

- 需要补的测试：`test-model-api.mjs` 增加三档 warnings 断言（`auto`/`true`/`false` 各一条），现在只测字段不测文案。
- 需要改的文档：`docs/guides/12-LESSONS-ARCHITECTURE.md` 可补一句「凡展示能力开关，一律展示生效值而非来源值」的通用教训。
