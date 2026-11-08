// 资源包导入落盘（src/meme-pack-import.js）的离线单测。
// 覆盖：正常导入 / 重复导入按 id 跳过 / md5 撞车去重 / 缺 manifest / 空包 / 非法 id / 只调一次 onSave。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { importMemePackDir } from '../src/meme-pack-import.js';
import { mergeStickerLibrary, normalizeStickerEntry } from '../src/sticker-lib.js';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pack-'));
}

function writePack(root, { id = 'official-001', categories = { 早上好: { description: '早安专用' } }, images = { '早上好/挥手.jpg': 'fake-jpg-1', '早上好/比心.jpg': 'fake-jpg-2' }, semantic = null } = {}) {
  fs.mkdirSync(path.join(root, 'memes', '早上好'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id, name: '测试包', version: '1.0.0', categories }));
  fs.writeFileSync(path.join(root, 'memes_data.json'), JSON.stringify({ 早上好: '早安问候用' }));
  for (const [rel, body] of Object.entries(images)) {
    const abs = path.join(root, 'memes', rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (semantic) fs.writeFileSync(path.join(root, 'semantic_metadata.json'), JSON.stringify(semantic));
  return root;
}

test('正常导入：复制图片、按 caption 生成描述、编号接着往后排', () => {
  const dir = mkTmp();
  const stateDir = mkTmp();
  writePack(dir, { semantic: { images: { '早上好/挥手.jpg': { caption: '挥手说早上好', tags: ['早上好', '打招呼'] } } } });
  const existing = [{ id: 'old', no: 7, md5: 'aaaa' }];
  let saved = null;
  const res = importMemePackDir(dir, {
    stateDir,
    entries: existing,
    findSticker: (list, id) => list.find((e) => e.id === id) || null,
    detectEmotions: (text) => (text.includes('早上好') ? [{ key: 'happy' }] : []),
    onSave: (next) => { saved = next; }
  });
  assert.equal(res.ok, true);
  assert.equal(res.added, 2);
  assert.equal(res.skipped, 0);
  assert.equal(res.total, 3);
  assert.deepEqual(res.pack, { id: 'official-001', name: '测试包', version: '1.0.0' });

  const first = res.entries.find((e) => e.content === '挥手说早上好');
  assert.ok(first, '应该有一条用了语义标注的 caption');
  assert.equal(first.no, 8, '编号要接着已有的最大编号往后排');
  assert.equal(first.emotion, 'happy');
  assert.ok(first.keywords.includes('打招呼'));
  assert.equal(first.source, 'pack');
  assert.equal(first.useCount, 0);
  assert.match(first.url, /^file:\/\/\//);
  assert.match(first.url, /sticker-files\/official-001\/早上好\/挥手\.jpg$/);
  assert.ok(fs.existsSync(path.join(stateDir, 'sticker-files', 'official-001', '早上好', '挥手.jpg')), '图片应被复制进表情目录');
  // 没有标注的那张退回分类描述
  const second = res.entries.find((e) => e.content === '早安问候用');
  assert.ok(second, '缺语义标注时应退回 memes_data 的分类描述');
  assert.equal(second.no, 9);
  assert.equal(saved, res.entries, 'onSave 必须收到合并后的完整条目表');
});

test('重复导入：按 id 全跳过，不再写文件、不再调 onSave', () => {
  const dir = mkTmp();
  const stateDir = mkTmp();
  writePack(dir);
  const first = importMemePackDir(dir, { stateDir, entries: [], findSticker: (l, id) => l.find((e) => e.id === id) || null, onSave: () => {} });
  let saveCount = 0;
  const second = importMemePackDir(dir, {
    stateDir,
    entries: first.entries,
    findSticker: (l, id) => l.find((e) => e.id === id) || null,
    onSave: () => { saveCount += 1; }
  });
  assert.equal(second.ok, true);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.equal(saveCount, 0, '没有新增时不应该落盘');
  assert.deepEqual(second.skippedDetail.map((s) => s.reason), ['exists', 'exists']);
});

test('md5 撞车：同一个包换了目录结构导两次，第二份按 duplicate 跳过', () => {
  const dirA = mkTmp();
  const dirB = mkTmp();
  const stateDir = mkTmp();
  writePack(dirA, { id: 'pack-a', images: { '早上好/同图.jpg': 'same-bytes' } });
  writePack(dirB, { id: 'pack-b', images: { '早上好/别的位置.jpg': 'same-bytes' } });
  const first = importMemePackDir(dirA, { stateDir, entries: [], findSticker: (l, id) => l.find((e) => e.id === id) || null, onSave: () => {} });
  assert.equal(first.added, 1);
  const second = importMemePackDir(dirB, { stateDir, entries: first.entries, findSticker: (l, id) => l.find((e) => e.id === id) || null, onSave: () => {} });
  assert.equal(second.added, 0);
  assert.equal(second.skippedDetail[0].reason, 'duplicate');
});

test('失败路径：目录不存在 / 缺 manifest / 空包 / 非法 id 都带 code+hint', () => {
  const missing = importMemePackDir(path.join(mkTmp(), 'nope'));
  assert.equal(missing.code, 'PACK_DIR_MISSING');
  assert.ok(missing.hint);

  const noManifest = mkTmp();
  const r1 = importMemePackDir(noManifest);
  assert.equal(r1.code, 'PACK_MANIFEST_UNREADABLE');

  const empty = mkTmp();
  writePack(empty, { images: {} });
  const r2 = importMemePackDir(empty);
  assert.equal(r2.code, 'PACK_EMPTY');

  const badId = mkTmp();
  writePack(badId, { id: '中文包' });
  const r3 = importMemePackDir(badId);
  assert.equal(r3.code, 'PACK_ID_CHARS');
  assert.equal(r3.ok, false);

  const emptyDir = importMemePackDir('');
  assert.equal(emptyDir.code, 'PACK_DIR_EMPTY');
});

test('非图片文件被忽略，只导 jpg/png/gif/webp', () => {
  const dir = mkTmp();
  const stateDir = mkTmp();
  writePack(dir, { images: { '早上好/图.jpg': 'img', '早上好/说明.txt': 'not image' } });
  const res = importMemePackDir(dir, { stateDir, entries: [], findSticker: () => null, onSave: () => {} });
  assert.equal(res.added, 1);
  assert.equal(res.entries.length, 1);
});

test('导入的 pack 条目必须保住 source=pack，不能被「QQ 端已删除」的同步清理带走', () => {
  // 2026-11-02 事故回归：normalizeStickerEntry 曾把非 manual/ai 的来源一律压成 qq，
  // 于是 445 张导进库后，下一次 syncStickerLibrary 把它们当成「QQ 端已删除」全部清掉。
  const dir = mkTmp();
  const stateDir = mkTmp();
  writePack(dir, { id: 'pack-keep', images: { '早上好/挥手.jpg': 'img-1', '早上好/比心.jpg': 'img-2' } });
  let saved = null;
  const res = importMemePackDir(dir, {
    stateDir,
    entries: [{ id: 'qq-1', no: 1, md5: 'BBBB', source: 'qq' }],
    findSticker: (l, id) => l.find((e) => e.id === id) || null,
    onSave: (next) => { saved = next; }
  });
  assert.equal(res.ok, true);
  assert.equal(res.added, 2);

  // 合并前先过一遍归一化（真实链路里 ensureStickerIndex / mergeStickerLibrary 都会走）
  const normalized = saved.map((e) => normalizeStickerEntry(e)).filter(Boolean);
  const imported = normalized.filter((e) => e.id.startsWith('local-pack-pack-keep'));
  assert.equal(imported.length, 2);
  assert.ok(imported.every((e) => e.source === 'pack'), '导入条目归一化后仍是 pack');

  // QQ 端这次一张收藏表情都没拉到（0 < count → complete=true），历史 qq 条目会被清理
  const merged = mergeStickerLibrary(normalized, [], { complete: true });
  assert.equal(merged.filter((e) => e.source === 'pack').length, 2, 'pack 条目必须留住');
  assert.equal(merged.find((e) => e.id === 'qq-1'), undefined, 'QQ 端已删除的 qq 条目照旧清理');
});

test('老条目没有 md5 时按 file:// 补算一次，同一个图换包 id 也不会重复入库', () => {
  const dir = mkTmp();
  const stateDir = mkTmp();
  // 先造一张「早就手工入库」的图：只有 file:// 地址，md5 是空串（真实库存里大肥鱼就是这样）
  const oldFile = path.join(stateDir, 'sticker-files', 'dafeiyu', 'ok.jpg');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, 'same-bytes');
  const legacy = [{ id: 'local-dafeiyu-ok', no: 3, md5: '', url: `file:///${oldFile.replace(/\\/g, '/')}`, source: 'manual' }];

  writePack(dir, { id: 'pack-new', images: { '早上好/同一张.jpg': 'same-bytes' } });
  let saved = null;
  const res = importMemePackDir(dir, {
    stateDir,
    entries: legacy,
    findSticker: (l, id) => l.find((e) => e.id === id) || null,
    onSave: (next) => { saved = next; }
  });
  assert.equal(res.ok, true);
  assert.equal(res.repaired, 1, '应该给老条目补一个 md5');
  assert.equal(res.added, 0, '同一张图不能再入库一次');
  assert.equal(res.skippedDetail[0].reason, 'duplicate');
  assert.match(legacy[0].md5, /^[0-9a-f]{32}$/, '补算的 md5 要写回条目，调用方才能落盘');
  assert.equal(saved, null, '没有新增时不调 onSave（补 md5 由桥接自己存）');

  // 第二次：md5 已经在条目上了，不该再算一遍
  const again = importMemePackDir(dir, { stateDir, entries: legacy, findSticker: () => null });
  assert.equal(again.repaired, 0);
});
