// 表情包资源包兼容层（src/meme-pack.js）的离线单测。
// 覆盖：包 id 校验 / manifest 归一化 / 分类推断 / 语义文件 v1+v2 / 条目草稿映射 / id 生成 / 导入清单清洗。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoryEmotionOf,
  normalizeImportItems,
  normalizePackManifest,
  packCategoryOf,
  packStickerId,
  parseSemanticMeta,
  stickerDraftFromMeme,
  validatePackId
} from '../src/meme-pack.js';

test('包 id：小写合法、空/超长/尾点/非法字符各自报错', () => {
  assert.deepEqual(validatePackId('official-001'), { ok: true, id: 'official-001' });
  assert.deepEqual(validatePackId('  LSP_Dafeiyu.2  '), { ok: true, id: 'lsp_dafeiyu.2' });
  assert.equal(validatePackId('').code, 'PACK_ID_EMPTY');
  assert.equal(validatePackId('a').code, 'PACK_ID_LENGTH');
  assert.equal(validatePackId('a'.repeat(65)).code, 'PACK_ID_LENGTH');
  assert.equal(validatePackId('abc.').code, 'PACK_ID_TRAILING_DOT');
  assert.equal(validatePackId('中文包').code, 'PACK_ID_CHARS');
  // 报错要能直接显示给人看：带 error 和 hint，不是光秃秃一个 false。
  const bad = validatePackId('bad id');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('非法字符'));
  assert.ok(bad.hint.length > 0);
});

test('manifest：缺 id 用目录名兜底，缺 name/version 补默认值', () => {
  const res = normalizePackManifest({ name: '', version: '' }, { fallbackId: 'my-pack' });
  assert.equal(res.ok, true);
  assert.equal(res.manifest.id, 'my-pack');
  assert.equal(res.manifest.name, 'my-pack');
  assert.equal(res.manifest.version, '0.0.0');
  assert.deepEqual(res.manifest.categories, {});
  assert.equal(res.manifest.source, null);
});

test('manifest：categories 归一化成 { 分类: { description } }，数组/字符串都兼容', () => {
  const res = normalizePackManifest({
    id: 'p1',
    name: '包一',
    version: '1.2.0',
    categories: { 早上好: { description: '早安专用' }, 生气: '怒' },
    source: { type: 'github', repo: 'a/b', ref: 'main', subpath: '' }
  });
  assert.equal(res.ok, true);
  assert.equal(res.manifest.categories['早上好'].description, '早安专用');
  assert.equal(res.manifest.categories['生气'].description, '怒');
  assert.equal(res.manifest.source.repo, 'a/b');
});

test('manifest：不是对象就报 PACK_MANIFEST_SHAPE', () => {
  assert.equal(normalizePackManifest([]).code, 'PACK_MANIFEST_SHAPE');
  assert.equal(normalizePackManifest(null).code, 'PACK_MANIFEST_SHAPE');
  assert.equal(normalizePackManifest('x').code, 'PACK_MANIFEST_SHAPE');
});

test('分类推断：第一段目录是分类，根下图片归「默认分类」', () => {
  assert.equal(packCategoryOf('早上好/a.jpg'), '早上好');
  assert.equal(packCategoryOf('早上好/子类/b.jpg'), '早上好');
  assert.equal(packCategoryOf('loose.jpg'), '默认分类');
  assert.equal(packCategoryOf(''), '默认分类');
});

test('语义文件：v2 images 表、v1 平铺、auto/manual 字段都认', () => {
  const v2 = parseSemanticMeta({
    schema_version: 2,
    images: {
      '早上好/a.jpg': { caption: '挥手打招呼', tags: ['早上好', '你好'] },
      '生气/b.jpg': { auto_caption: '抱臂生气', manual_tags: ['生气'] },
      '空/c.jpg': {}
    }
  });
  assert.equal(v2['早上好/a.jpg'].caption, '挥手打招呼');
  assert.deepEqual(v2['早上好/a.jpg'].tags, ['早上好', '你好']);
  assert.equal(v2['生气/b.jpg'].caption, '抱臂生气');
  assert.deepEqual(v2['生气/b.jpg'].tags, ['生气']);
  assert.equal(v2['空/c.jpg'], undefined); // 既没 caption 也没 tags 的丢弃，不产生空条目
  const v1 = parseSemanticMeta({ 'x/1.png': { caption: '单图', tags: [] } });
  assert.equal(v1['x/1.png'].caption, '单图');
  assert.deepEqual(parseSemanticMeta(null), {});
});

test('条目草稿：caption 优先，其次分类描述，最后分类名', () => {
  const pack = { id: 'p1', name: '大肥鱼包' };
  const withCaption = stickerDraftFromMeme({ pack, rel: '早上好/a.jpg', meta: { caption: '挥手早上好', tags: ['你好'] }, categoryDescription: '早安专用' });
  assert.equal(withCaption.content, '挥手早上好');
  const withCatDesc = stickerDraftFromMeme({ pack, rel: '早上好/a.jpg', categoryDescription: '早安专用' });
  assert.equal(withCatDesc.content, '早安专用');
  const bare = stickerDraftFromMeme({ pack, rel: '早上好/a.jpg' });
  assert.equal(bare.content, '早上好');
  assert.ok(bare.tags.includes('大肥鱼包'));
  assert.ok(bare.tags.includes('meme-pack'));
});

test('条目草稿：情绪用注入的 detectEmotions 推断，推不出落到 neutral', () => {
  const pack = { id: 'p1', name: '包' };
  const hit = stickerDraftFromMeme({
    pack,
    rel: '生气/a.jpg',
    meta: { caption: '气死了', tags: ['生气'] },
    detectEmotions: (text) => (text.includes('生气') || text.includes('气死') ? [{ key: 'angry' }] : [])
  });
  assert.equal(hit.emotion, 'angry');
  const miss = stickerDraftFromMeme({ pack, rel: 'x/a.jpg', detectEmotions: () => [] });
  assert.equal(miss.emotion, 'neutral');
  // detectEmotions 抛错也不能把导入弄挂
  const boom = stickerDraftFromMeme({ pack, rel: 'x/a.jpg', detectEmotions: () => { throw new Error('boom'); } });
  assert.equal(boom.emotion, 'neutral');
});

test('分区目录名当情绪：dsh-meme 的英文分类能对上 SurfCore 的 20 类', () => {
  // 2026-11-02 实测：dsh-meme 的图库用 angry/happy/daily/sleep… 这套英文目录，
  // 不映射的话 1145 条里 1079 条落进 neutral，按情绪配图永远挑不中。
  assert.equal(categoryEmotionOf('angry').key, 'angry');
  assert.equal(categoryEmotionOf('sleep').key, 'tired');
  assert.equal(categoryEmotionOf('surprised').key, 'surprise');
  assert.equal(categoryEmotionOf('baka').key, 'tease');
  assert.equal(categoryEmotionOf('daily').key, 'neutral');
  assert.equal(categoryEmotionOf('daily').label, '日常');
  assert.equal(categoryEmotionOf('生气').key, 'angry', '中文目录名也要认');
  const draft = stickerDraftFromMeme({ pack: { id: 'p1', name: '大肥鱼2.0' }, rel: 'angry/a.jpg' });
  assert.equal(draft.emotion, 'angry', '没有 caption 时用分类目录的情绪');
  assert.equal(draft.content, '生气', 'content 用中文标签，别把 angry 原样塞进去');
  assert.ok(draft.keywords.includes('生气'));
});

test('id 生成：去扩展名、保留中文、压掉符号、重复调用稳定', () => {
  assert.equal(packStickerId('p1', '早上好/挥手 你好.jpg'), 'local-pack-p1-早上好-挥手-你好');
  assert.equal(packStickerId('p1', 'a/b.PNG'), 'local-pack-p1-a-b');
  assert.equal(packStickerId('P1', 'x.webp'), packStickerId('P1', 'x.webp'));
  assert.equal(packStickerId('p1', '!!!.gif'), 'local-pack-p1-item');
});

test('导入清单：按 id 去重、丢掉空内容、按 limit 截断', () => {
  const res = normalizeImportItems([
    { id: 'a', content: '一' },
    { id: 'a', content: '重复' },
    { id: 'b', content: '   ' },
    { id: 'c', content: '三', keywords: ['x', ''], emotion: '' }
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items.map((i) => i.id), ['a', 'c']);
  assert.deepEqual(res.items[1].keywords, ['x']);
  assert.equal(res.items[1].emotion, 'neutral');
  const capped = normalizeImportItems(Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, content: `c${i}` })), { limit: 3 });
  assert.equal(capped.items.length, 3);
  assert.equal(normalizeImportItems('nope').code, 'PACK_IMPORT_SHAPE');
});
