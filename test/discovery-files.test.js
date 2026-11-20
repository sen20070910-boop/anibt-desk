import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiscoveryFiles, selectDiscoveryFiles } from '../src/discovery-files.js';
import { QbClient } from '../src/qb.js';
import { submitAgain } from '../src/reprocessing.js';

const hash = 'a'.repeat(40);
const item = { infoHash: hash, magnet: 'magnet:?xt=urn:btih:' + hash };
const metadata = {
  infohash_v1: hash,
  info: { files: [
    { path: 'Release/Movie.mkv', length: 3000 },
    { path: 'Release/Movie.sc.ass', length: 3 },
    { path: 'Release/Movie.tc.ass', length: 3 },
    { path: 'Release/[Fonts].zip', length: 50 },
    { path: 'Release/Movie.mka', length: 2100 },
    { path: 'Release/SPs/Bonus.mkv', length: 6000 },
    { path: 'Release/CDs/Soundtrack.flac', length: 200 },
    { path: 'Release/Scans/Cover.jpg', length: 10 },
  ] },
};
const files = metadata.info.files.map(row => ({ path: row.path, size: row.length }));
const priorities = [1, 1, 0, 1, 0, 0, 0, 0];

test('a film pack recommends the movie, matching simplified ASS and fonts, leaving tracks and extras optional', () => {
  const rows = classifyDiscoveryFiles(files);
  assert.deepEqual(rows.map(row => row.kind), ['video', 'subtitle', 'subtitle', 'font', 'audio', 'extra', 'extra', 'extra']);
  assert.deepEqual(rows.slice(1, 3).map(row => row.language), ['简中', '繁中']);
  assert.deepEqual(selectDiscoveryFiles(rows, rows.filter(row => row.recommended).map(row => row.index)), priorities);
  assert.throws(() => selectDiscoveryFiles(rows, []), /至少勾选/);
  assert.throws(() => selectDiscoveryFiles(rows, [8]), /当前文件列表/);
});

function makeQb({ ignorePriorities = false } = {}) {
  const qb = new QbClient({ qb: { url: 'http://127.0.0.1:8080', savePath: '' } });
  const calls = [];
  qb.has = async () => calls.includes('torrents/add');
  qb.request = async (method, body) => {
    calls.push(method);
    if (method === 'torrents/fetchMetadata') {
      assert.equal(body.get('source'), item.magnet);
      return Response.json(metadata);
    }
    if (method === 'torrents/add') {
      assert.equal(body.get('filePriorities'), priorities.join(','));
      assert.equal(body.get('stopped'), 'true');
      assert.equal(body.has('torrents'), false);
      return Response.json({ success_count: 1 });
    }
    if (method === 'torrents/files') {
      return Response.json(priorities.map((priority, index) => ({ index, priority: ignorePriorities ? 1 : priority })));
    }
    if (method === 'torrents/start') return new Response(null, { status: 204 });
    throw new Error('Unexpected request ' + method);
  };
  return { qb, calls };
}

test('qB starts only after its transfer reports the exact selected priorities', async () => {
  const { qb, calls } = makeQb();
  await qb.add(item, { fileSelection: { files, priorities } });
  assert.deepEqual(calls, ['torrents/fetchMetadata', 'torrents/add', 'torrents/files', 'torrents/start']);
});

test('qB keeps the transfer stopped if the downloader ignores file selection', async () => {
  const { qb, calls } = makeQb({ ignorePriorities: true });
  await assert.rejects(() => qb.add(item, { fileSelection: { files, priorities } }), /未能核对文件优先级/);
  assert.equal(calls.includes('torrents/start'), false);
});

test('preview order or metadata changes are rejected before submitting to qB', async () => {
  const { qb, calls } = makeQb();
  await assert.rejects(() => qb.add(item, { fileSelection: { files: [...files].reverse(), priorities } }), /清单已变化/);
  assert.deepEqual(calls, ['torrents/fetchMetadata']);
});

test('reprocessing history does not silently redownload a deleted selective task as a full pack', async () => {
  const qb = { list: async () => [], add: async () => { throw new Error('unexpected submit'); } };
  await assert.rejects(() => submitAgain(qb, item, { requireExisting: true }), /重新勾选/);
});

test('subtitle filenames distinguish Chinese without a script tag from simplified and other languages', () => {
  const rows = classifyDiscoveryFiles(['movie.chi.ass', 'movie.zh-Hans.srt', 'movie.ita.srt', 'movie.eng.sup']
    .map(path => ({ path, size: 5 })));
  assert.deepEqual(rows.map(x => x.language), ['中文（简繁未标注）', '简中', '意大利语', '英语']);
});

test('dual-language VCB sidecars select the matching simplified subtitle and Fonts archive', () => {
  const stem = 'Release/[Nekomoe kissaten&VCB-Studio] Kusuriya no Hitorigoto 2nd Season [48][Ma10p_1080p][x265_flac_aac]';
  const files = [stem+'.mkv', stem+'.JPSC.ass', stem+'.JPTC.ass', 'Release/Season [Fonts].7z', 'Release/SPs/Bonus.JPSC.ass']
    .map(path => ({ path, size: 10 }));
  const rows = classifyDiscoveryFiles(files);
  assert.deepEqual(rows.map(row => row.language), ['', '简中 / 日文', '繁中 / 日文', '', '']);
  assert.deepEqual(rows.map(row => row.recommended), [true, true, false, true, false]);
  const withoutMatchingSimplified = classifyDiscoveryFiles(files.filter((_, index) => index !== 1));
  assert.equal(withoutMatchingSimplified.find(row => row.kind === 'font').recommended, false);
});
