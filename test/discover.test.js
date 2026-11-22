import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeHash,magnetHash,torrentInfoHash } from '../src/torrent.js';
import { sourceUrl,validateProxy } from '../src/source-network.js';
import { inferRelease,releaseWorkTitle,parseNyaa,parseDmhy,parseVcbProjects,mergeReleases,createDiscovery,parseAcgRip,parseMoe,parseNekoBt,parseSeaDex } from '../src/discover.js';

const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
const info={name:'local-test.txt',length:1,'piece length':16384,pieces:createHash('sha1').update('x').digest(),private:1};
const torrent=encode({info}),hash=createHash('sha1').update(encode(info)).digest('hex');
const title='[VCB-Studio] 测试作品 - 01 [1080p][简繁内封]';
const rss=`<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item><title>${title}</title><link>https://nyaa.si/download/1.torrent</link><guid>https://nyaa.si/view/1</guid><nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:seeders>8</nyaa:seeders><nyaa:size>1 GiB</nyaa:size><pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
const dmhy=`<table id="topic_list"><tbody><tr><td>2026/11/01 08:00</td><td>動畫</td><td class="title"><span class="tag">VCB-Studio</span><a href="/topics/view/1_demo.html">${title}</a></td><td><a href="magnet:?xt=urn:btih:${hash}">磁力</a></td><td>1GB</td><td>3</td></tr></tbody></table>`;
const anibt=`<rss xmlns:anibt="https://anibt.net/xmlns/rss/1.0/"><channel><item><title>${title}</title><guid>rel_test</guid><anibt:animeTitle>测试作品</anibt:animeTitle><anibt:language>CHS</anibt:language><anibt:language>CHT</anibt:language><torrent><infohash>${hash}</infohash></torrent><enclosure url="https://anibt.net/api/torrent/rel_test.torrent"/></item></channel></rss>`;
function mockNetwork({vcbBlocked=true,badTorrent=false}={}){const calls=[];return{calls,cacheKey:()=> 'test',close:async()=>{},read:async(url,options={})=>{calls.push(url);const u=new URL(url);if(options.binary)return{bytes:badTorrent?encode({info:{...info,name:'different.txt'}}):torrent,via:'test'};if(u.hostname==='vcb-s.com'){if(vcbBlocked)throw Object.assign(new Error('validation'),{code:'BROWSER_REQUIRED'});return{text:`<article><h2 class="entry-title"><a href="/archives/12">测试作品 HEVC BDRip [Fin]</a></h2><div class="entry-content"><a href="magnet:?xt=urn:btih:${hash}">下载</a></div></article>`,url,via:'test'};}return{text:u.hostname==='anibt.net'?anibt:u.hostname==='nyaa.si'?rss:dmhy,via:'test',url};}};}
test('torrent IDs normalize base32/hex magnets to the same 20-byte hash',()=>{assert.equal(normalizeHash('A'.repeat(32)),'0'.repeat(40));assert.equal(magnetHash('magnet:?xt=urn:btih:'+'A'.repeat(32)),'0'.repeat(40));assert.equal(normalizeHash(hash.toUpperCase()),hash);assert.equal(normalizeHash('invalid'),'');});
test('torrent hash uses exact encoded info and rejects broken or duplicate dictionaries',()=>{assert.equal(torrentInfoHash(torrent),hash);assert.throws(()=>torrentInfoHash(Buffer.from('<html>error</html>')));assert.throws(()=>torrentInfoHash(Buffer.from('d4:infod1:ai1ee4:infod1:ai2eee')));assert.throws(()=>torrentInfoHash(torrent.subarray(0,-2)));});
test('external fetch URL validation permits only supported hosts and proxy syntax',()=>{assert.equal(sourceUrl('http://share.dmhy.org/topics/view/1.html'),'https://share.dmhy.org/topics/view/1.html');for(const url of ['http://127.0.0.1/a','https://nyaa.si@evil.test/a','file:///c:/a','https://nyaa.si:8443/a'])assert.throws(()=>sourceUrl(url));assert.equal(validateProxy('http://127.0.0.1:7890'),'http://127.0.0.1:7890');assert.throws(()=>validateProxy('http://user:secret@127.0.0.1:7890'));});
test('Nyaa RSS and DMHY search parse hash, subtitle, size, seeders and source links',()=>{const n=parseNyaa(rss)[0],d=parseDmhy(dmhy)[0];assert.equal(n.infoHash,d.infoHash);assert.deepEqual(n.languages,['CHS','CHT']);assert.equal(n.sizeBytes,1024**3);assert.equal(d.sizeBytes,1e9);assert.equal(n.seeders,8);assert.equal(d.seeders,3);assert.equal(d.pageUrl,'https://www.dmhy.org/topics/view/1_demo.html');assert.equal(n.workTitle,'测试作品');assert.throws(()=>parseNyaa('<html>login</html>'));assert.throws(()=>parseDmhy('<html>login</html>'));});
test('subtitle inference does not claim simplified Chinese for unknown VCB subtitles',()=>{assert.deepEqual(inferRelease('[VCB-Studio] Demo 1080p HEVC').languages,[]);assert.deepEqual(inferRelease('[ANi] Demo [CHT]').languages,['CHT']);assert.ok(inferRelease('[Test] Demo [CHS]').languages.includes('CHS'));});

test('work titles remove complete technical suffixes and keep the original release title', () => {
  const prefix = 'One Piece Fan Letter';
  for (const sample of [
    '[HatSubs] One Piece Fan Letter (BD 1080p 10-bit Opus) [3D18E382].mkv',
    '[MicroHatSubs] One Piece Fan Letter (WEB 1080p AV1 Opus) [B8B75D38].mkv',
    '[One Pace] One Piece Fan Letter [1080p][99510B34].mkv',
    'One Piece Fan Letter 1080p HEVC [Multiple Subtitle]',
  ]) assert.equal(releaseWorkTitle(sample), prefix);
  assert.equal(releaseWorkTitle('[Test] 作品 - 01 [CHS]'), '作品');
  assert.equal(releaseWorkTitle('Tokyo Godfathers (2003) [BluRay.1080p.x264.FLAC].mkv'), 'Tokyo Godfathers (2003)');
  assert.equal(releaseWorkTitle('[Test] Re:Zero (Season 2) [1080p]'), 'Re:Zero (Season 2)');
});

test('discover uses a verified Bangumi alternate title when AniBT supplies only the canonical spelling', async () => {
  const query = '海贼王粉丝来信';
  const row = { id: 518519, type: 2, name: 'ONE PIECE FAN LETTER', name_cn: '航海王：粉丝来信' };
  const release = '[HatSubs] One Piece Fan Letter (BD 1080p 10-bit Opus) [3D18E382].mkv';
  const network = {
    cacheKey: () => 'test',
    async read(address, options) {
      const url = new URL(address);
      if (url.hostname === 'anibt.net') return { text: JSON.stringify({page: [
        { bgmId: row.id, title: { chinese: row.name_cn, native: row.name } },
      ]}) };
      if (url.pathname === '/v0/search/subjects') {
        assert.equal(options.jsonBody.keyword, query);
        return { text: JSON.stringify({data: [row]}) };
      }
      if (url.pathname === '/v0/subjects/518519') return {
        text: JSON.stringify({...row, infobox: [{key: '别名', value: [{v: '海贼王 粉丝来信'}]}]}),
      };
      return { text: JSON.stringify({status: 'OK', resources: url.searchParams.get('search') === row.name
        ? [{title: release, magnet: 'magnet:?xt=urn:btih:' + hash, provider: 'dmhy', providerId: '100'}] : []}) };
    },
  };
  const discovery = createDiscovery(() => ({}), {network});
  const result = await discovery.search({query, sources: ['garden']});
  assert.deepEqual(result.aliases, [row.name_cn, row.name]);
  assert.equal(result.items[0].title, release);
  assert.equal(result.items[0].workTitle, 'One Piece Fan Letter');
  assert.equal((await discovery.search({query, sources: ['garden'], fuzzy: false})).total, 0);
});

test('ACG.RIP uses its own public torrent and checks unknown hashes when resolving and reopening', async () => {
  const feed = '<rss xmlns:torrent="urn:test"><channel>'
    + '<item><title>测试作品 [简中]</title><link>https://acg.rip/t/123</link><torrent:contentLength>1234</torrent:contentLength></item>'
    + '<item><title>无效发布</title><link>https://invalid.example/t/123</link></item></channel></rss>';
  assert.equal(parseAcgRip(feed).length, 1);
  assert.equal(parseAcgRip(feed)[0].sizeBytes, 1234);
  const network = {
    cacheKey: () => 'test',
    async read(address, options) {
      if (options?.binary) {
        assert.equal(address, 'https://acg.rip/t/123.torrent');
        return { bytes: torrent };
      }
      assert.equal(new URL(address).searchParams.get('term'), '测试作品');
      return { text: feed };
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const { items: [result] } = await discovery.search({ sources: ['acg'], query: '测试作品', fuzzy: false });
  assert.equal(result.infoHash, '');
  assert.equal(result.downloadable, true);
  assert.equal((await discovery.resolve(result.resultId)).infoHash, hash);
  const restored = discovery.reopen({ hash, title: result.title, sourceLinks: result.links });
  assert.deepEqual(restored.sources, ['acg']);
  assert.equal((await discovery.resolve(restored.resultId)).infoHash, hash);
});

test('nekoBT keeps audio separate from subtitles and groups episodes by season', () => {
  const item = {
    id: '127125', title: '[group] Demo S02E04 1080p', infohash: hash, batch: false,
    audio_lang: 'ja,zh-hans', sub_lang: 'zh-hant,ru', fsub_lang: 'en',
    private_magnet: 'magnet:?xt=urn:btih:' + hash + '&secret=never-read',
  };
  const [row] = parseNekoBt(JSON.stringify({ error: false, data: { results: [item, { ...item, hidden: true }] } }));
  assert.equal(row.workTitle, 'Demo S02');
  assert.equal(row.episode, '04');
  assert.deepEqual(row.languages, ['CHT', 'RU', 'EN']);
  assert.deepEqual(row.audioLanguages, ['JA', 'CHS']);
  assert.equal(row.torrentUrl, 'https://nekobt.to/api/v1/torrents/127125/download?public=true');
  assert.ok(!row.magnet.includes('never-read'));
});

test('SeaDex uses matched AniList IDs and merges supported public recommendations by hash', async () => {
  const publicRow = { infoHash: hash, url: 'https://nyaa.si/view/1', isBest: true, releaseGroup: 'Group' };
  const entries = { items: [{ alID: 275, expand: { trs: [
    publicRow, { ...publicRow, infoHash: '<redacted>' },
    { ...publicRow, url: 'https://evil.example/view/1' },
  ] } }] };
  assert.equal(parseSeaDex(JSON.stringify(entries), new Map([[275, 'Demo']])).length, 1);
  const moe = { _id: 'd'.repeat(24), category_tag_id: '549ef207fe682f7549f1ea90', title, infoHash: hash, seeders: 5 };
  assert.equal(parseMoe(JSON.stringify({ torrents: [moe, { ...moe, category_tag_id: 'music' }] })).length, 1);
  const network = {
    cacheKey: () => 'test',
    async read(address, options) {
      const url = new URL(address);
      if (options?.binary) return { bytes: torrent };
      if (url.hostname === 'graphql.anilist.co') {
        assert.deepEqual(options.jsonBody.variables, { q0: 'Demo' });
        return { text: JSON.stringify({data:{q0:{media:[{id:275,title:{romaji:'Demo'}}]}}}) };
      }
      if (url.hostname === 'seadex.moe') {
        assert.equal(url.searchParams.get('filter'), 'alID=275');
        return { text: JSON.stringify(entries) };
      }
      assert.equal(url.hostname, 'bangumi.moe');
      return { text: JSON.stringify({ torrents: [moe] }) };
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const result = await discovery.search({ sources: ['moe','seadex'], query: 'Demo', fuzzy: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].seadexRating, 'best');
  assert.deepEqual(result.items[0].sources, ['moe','seadex']);
  assert.ok(result.items[0].links.some(link => link.source === 'nyaa'));
  assert.equal((await discovery.resolve(result.items[0].resultId)).infoHash, hash);
});
test('VCB project parser reads title, project URL and magnet without executing page content',()=>{const projects=parseVcbProjects(`<article><h2 class="entry-title"><a href="/archives/12">测试作品 HEVC BDRip [Fin]</a></h2><div class="entry-content"><script>ignored()</script><a href="magnet:?xt=urn:btih:${hash}">下载</a></div></article>`);assert.equal(projects.length,1);assert.equal(projects[0].pageUrl,'https://vcb-s.com/archives/12');assert.equal(projects[0].infoHash,hash);});
test('cross-source merge combines origins while keeping only one torrent and highest seed count',()=>{const merged=mergeReleases([...parseDmhy(dmhy),...parseNyaa(rss)]);assert.equal(merged.length,1);assert.deepEqual(merged[0].sources,['dmhy','nyaa']);assert.equal(merged[0].links.length,2);assert.equal(merged[0].seeders,8);});
test('unified search tolerates VCB browser validation and clearly labels associated releases',async()=>{const network=mockNetwork();const service=createDiscovery(()=>({}),{network});const search={query:'VCB-Studio',sources:['anibt','dmhy','nyaa','vcb'],fuzzy:false};const result=await service.search(search);assert.equal(result.items.length,1);assert.deepEqual(new Set(result.items[0].sources),new Set(['anibt','dmhy','nyaa','vcb']));assert.equal(result.providers.find(p=>p.source==='vcb').state,'fallback');assert.ok(result.providers.find(p=>p.source==='vcb').message.includes('浏览器验证'));assert.equal(result.items[0].links.length,3);const calls=network.calls.length;await service.search(search);assert.equal(network.calls.length,calls);const resolved=await service.resolve(result.items[0].resultId);assert.equal(resolved.infoHash,hash);assert.equal(torrentInfoHash(resolved.torrentData),hash);});
test('original VCB project pages can resolve a directly linked magnet',async()=>{const service=createDiscovery(()=>({}),{network:mockNetwork({vcbBlocked:false})});const result=await service.search({sources:['vcb']});assert.equal(result.providers[0].state,'ok');assert.equal(result.items[0].kind,'project');assert.equal((await service.resolve(result.items[0].resultId)).infoHash,hash);});
test('search IDs expire and cannot be replaced with arbitrary client URLs',async()=>{let now=1000;const service=createDiscovery(()=>({}),{network:mockNetwork(),now:()=>now});const r=await service.search({sources:['nyaa']});await assert.rejects(service.resolve('https://evil.test/file.torrent'));now+=1800001;await assert.rejects(service.resolve(r.items[0].resultId),/过期/);await assert.rejects(service.search({sources:['invalid']}));await assert.rejects(service.search({query:'番'.repeat(60)}));});
test('mismatched torrent content is rejected before qB can receive it',async()=>{const service=createDiscovery(()=>({}),{network:mockNetwork({badTorrent:true})});const r=await service.search({sources:['nyaa']});await assert.rejects(service.resolve(r.items[0].resultId),/不一致/);});
test('one unreachable source does not suppress working results',async()=>{const network=mockNetwork();const read=network.read;network.read=async(url,options)=>{if(new URL(url).hostname==='nyaa.si')throw new Error('offline');return read(url,options);};const service=createDiscovery(()=>({}),{network});const r=await service.search({sources:['anibt','nyaa']});assert.equal(r.items.length,1);assert.equal(r.providers.find(p=>p.source==='nyaa').state,'error');});

test('alternate Chinese titles can find and merge the same release across Garden and Mikan', async () => {
  const query = '药屋少女的呢喃';
  const translated = '藥師少女的獨語';
  const release = '[测试组] ' + translated + ' - 01 [1080p][简中]';
  const magnet = 'magnet:?xt=urn:btih:' + hash;
  const calls = [];
  const network = {
    cacheKey: () => 'test',
    close: async () => {},
    async read(address, options) {
      const url = new URL(address);
      calls.push(url);
      if (options?.binary) {
        assert.equal(url.hostname, 'mikanime.tv');
        return { bytes: torrent };
      }
      if (url.hostname === 'api.animes.garden') {
        return { via: 'test', text: JSON.stringify({ status: 'OK', resources: url.searchParams.get('search') === translated
          ? [{ title: release, magnet, tracker: '&tr=udp%3A%2F%2Ftracker.example%3A80', size: 1073741824, provider: 'dmhy', providerId: '100', href: 'https://share.dmhy.org/topics/view/100.html' }] : [] }) };
      }
      assert.equal(url.hostname, 'mikanime.tv');
      const text = url.searchParams.get('searchstr') === translated
        ? '<table class="tbl-border"><tbody><tr><td><input data-magnet="' + magnet + '"></td>'
          + '<td><a href="/Home/Episode/' + hash + '">' + release + '</a></td><td>1 GiB</td>'
          + '<td>2026/11/18 13:30</td><td><a href="/Download/20261118/' + hash + '.torrent">种子</a></td></tr></tbody></table>'
        : '<html><body>找不到对应结果</body></html>';
      return { text, via: 'test' };
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const opts = { query, sources: ['garden', 'mikan'] };
  const exact = await discovery.search({ ...opts, fuzzy: false });
  assert.equal(exact.items.length, 0);
  assert.equal(calls.length, 2);
  const result = await discovery.search(opts);
  assert.ok(result.aliases.includes(translated));
  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.deepEqual(item.sources, ['garden', 'mikan']);
  assert.deepEqual(item.languages, ['CHS']);
  assert.equal(item.infoHash, hash);
  assert.deepEqual(item.links.map(link => new URL(link.url).hostname), ['animes.garden', 'share.dmhy.org', 'mikanime.tv']);
  const resolved = await discovery.resolve(item.resultId);
  assert.equal(torrentInfoHash(resolved.torrentData), hash);
  assert.equal(new URL(resolved.magnet).searchParams.get('tr'), 'udp://tracker.example:80');
});

test('catalog aliases expand a specific season and leave unrelated titles out', async () => {
  const calls = [];
  const network = {
    cacheKey: () => 'test',
    close: async () => {},
    async read(address) {
      const url = new URL(address);
      calls.push(url);
      if (url.hostname === 'anibt.net') {
        return { text: JSON.stringify({ page: [
          { title: { chinese: '新番', native: '新番の物語' } },
          { title: { chinese: '新番 第二季', chineseTraditional: '新番 第二季', native: '新番の物語 第2期', english: 'New Anime S2' } },
        ] }) };
      }
      return { text: JSON.stringify({ status: 'OK', resources: [] }), via: 'test' };
    },
  };
  const result = await createDiscovery(() => ({}), { network }).search({ query: '新番 第二季', sources: ['garden'] });
  assert.deepEqual(result.aliases, ['新番の物語 第2期', 'New Anime S2']);
  assert.deepEqual(calls.filter(url => url.hostname === 'api.animes.garden').map(url => url.searchParams.get('search')),
    ['新番 第二季', '新番の物語 第2期', 'New Anime S2']);
});

test('an explicit first season also searches its unnumbered title and keeps returned releases from every season', async () => {
  const base = '药屋少女的呢喃';
  const query = base + ' 第一季';
  const releases = [
    '药屋少女的呢喃 - 01',
    '藥師少女的獨語 第一季 [1-24]',
    '药屋少女的呢喃 第二季 - 01',
    'Kusuriya no Hitorigoto S02E01',
    '薬屋のひとりごと 第3期',
    'The Apothecary Diaries 2nd Season',
  ];
  const network = {
    cacheKey: () => 'test',
    close: async () => {},
    async read(address) {
      const q = new URL(address).searchParams.get('search');
      return { text: JSON.stringify({
        status: 'OK',
        resources: q === base ? releases.map((title, i) => ({
          title, magnet: 'magnet:?xt=urn:btih:' + String(i).repeat(40), provider: 'dmhy', providerId: String(i + 1),
        })) : [],
      }), via: 'test' };
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const result = await discovery.search({ query, sources: ['garden'] });
  assert.ok(result.aliases.includes(base));
  assert.deepEqual(result.items.map(item => item.title), releases);
  assert.equal((await discovery.search({ query, sources: ['garden'], fuzzy: false })).total, 0);
});

test('resource discovery includes older search pages and keeps results past the former merged limit', async () => {
  const hashOf = index => index.toString(16).padStart(40, '0');
  const network = {
    cacheKey: () => 'test',
    async read(url) {
      const address = new URL(url);
      if (address.hostname === 'api.animes.garden') {
        const older = address.searchParams.get('page') === '2';
        const start = older ? 101 : 1;
        const resources = Array.from({length: 100}, (_, index) => ({
          title: older ? '测试作品 第一季 ' + index : '测试作品 第二季 ' + index,
          magnet: 'magnet:?xt=urn:btih:' + hashOf(start + index),
          provider: 'dmhy', providerId: String(start + index),
          createdAt: older ? '2025-06-01' : '2026-06-01',
        }));
        return { text: JSON.stringify({status: 'OK', resources}) };
      }
      assert.equal(address.hostname, 'nyaa.si');
      const items = Array.from({length: 60}, (_, index) => `<item><title>测试作品 第二季 Nyaa ${index}</title>
        <nyaa:infoHash>${hashOf(201 + index)}</nyaa:infoHash><pubDate>2026-07-01</pubDate></item>`).join('');
      return {text: '<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>' + items + '</channel></rss>'};
    },
  };
  const result = await createDiscovery(() => ({}), { network }).search({
    query: '测试作品', sources: ['garden', 'nyaa'], fuzzy: false,
  });
  assert.equal(result.items.length, 260);
  assert.equal(result.total, 260);
  assert.equal(result.truncated, false);
  assert.match(result.items[259].title, /第一季/);
  assert.equal(result.providers[0].count, 200);
});

test('DMHY follows the search next-page link and preserves the first page if it fails', async () => {
  const calls = [];
  let missing = false;
  const network = {
    cacheKey: () => 'test',
    async read(address) {
      const url = new URL(address);
      calls.push([url.pathname, url.searchParams.get('keyword')]);
      if (url.pathname.endsWith('/page/2')) {
        if (missing) throw Error('next page is offline');
        return {text: dmhy.replaceAll(hash, '2'.repeat(40)).replace('2026/11/01', '2025/11/01')};
      }
      return {text: dmhy + '<a href="/topics/list/page/2?keyword=ignored">下一頁</a>'};
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const options = { query: '测试作品', sources: ['dmhy'], fuzzy: false };
  assert.equal((await discovery.search(options)).total, 2);
  assert.deepEqual(calls, [
    ['/topics/list', '测试作品'], ['/topics/list/page/2', '测试作品'],
  ]);
  missing = true;
  const fallback = await discovery.search({ ...options, refresh:true });
  assert.equal(fallback.total, 1);
  assert.match(fallback.providers[0].message, /保留首批结果/);
});

test('VCB-only searches find an alternate-name release on Mikan if the official site requires verification', async () => {
  const release = '[喵萌奶茶屋&VCB-Studio] 药师少女的独语 1080p BDRip [S1 Reseed Fin]';
  const network = {
    cacheKey: () => 'test',
    close: async () => {},
    async read(address) {
      const url = new URL(address);
      if (url.hostname === 'vcb-s.com') throw Object.assign(new Error('challenge'), { code: 'BROWSER_REQUIRED' });
      if (url.hostname === 'mikanime.tv' && url.searchParams.get('searchstr') === '药师少女的独语') {
        return { text: '<table class="tbl-border"><tbody><tr><td><a href="/Home/Episode/' + hash + '">' + release + '</a>'
          + '<input data-magnet="magnet:?xt=urn:btih:' + hash + '"></td><td>40 GiB</td></tr></tbody></table>', via: 'test' };
      }
      throw new Error('no results from this source');
    },
  };
  const service = createDiscovery(() => ({}), { network });
  const result = await service.search({ query: '药屋少女的呢喃 第一季', sources: ['vcb'] });
  assert.equal(result.providers[0].state, 'fallback');
  assert.match(result.providers[0].message, /蜜柑计划/);
  assert.equal(result.items[0].title, release);
  assert.deepEqual(result.items[0].sources, ['vcb']);
  assert.deepEqual(result.items[0].links, [{ source: 'mikan', url: 'https://mikanime.tv/Home/Episode/' + hash }]);
});

test('script variants and release-style season numbers resolve only the intended catalog season', async () => {
  const catalog = [
    { bgmId: 10, title: { chinese: '深夜侦探', chineseTraditional: '深夜偵探' } },
    { bgmId: 20, title: { chinese: '深夜侦探 第二季', chineseTraditional: '深夜偵探 第二季', native: '探偵 第2期' } },
  ];
  const calls = [];
  const network = {
    cacheKey: () => 'test',
    close: async () => {},
    async read(address) {
      const url = new URL(address);
      if (url.hostname === 'anibt.net') {
        return { text: JSON.stringify({ page: catalog }) };
      }
      calls.push(url.searchParams.get('search'));
      return { text: '{"status":"OK","resources":[]}' };
    },
  };
  const discovery = createDiscovery(() => ({}), { network });
  const result = await discovery.search({ query: '深夜偵探 S02', sources: ['garden'] });
  assert.deepEqual(result.aliases, ['深夜侦探 第二季', '深夜偵探 第二季', '探偵 第2期']);
  assert.equal(calls.includes('深夜侦探'), false);
  assert.equal(calls.includes('深夜偵探'), false);
});

test('subtitle labels distinguish explicit subtitle languages from a release audio tag', () => {
  assert.deepEqual(inferRelease('Tokyo Godfathers (2003) [BluRay.1080p.x264.FLAC.ITA.AAC.JAP.ENG.Subs.Ita.Eng.v2]').languages, ['IT', 'EN']);
  assert.deepEqual(inferRelease('Demo [BluRay.1080p.FLAC.ITA.AAC.JAP.ENG]').languages, []);
});

test('Nyaa release descriptions read subtitle tables and tracks without inferring from audio', async () => {
  const { readNyaaSubtitleDetails } = await import('../src/nyaa-subtitles.js');
  const body = '<div id="torrent-description">AUDIO\nLanguage: Japanese\n**_Subtitles_** | English, French\nSUBTITLE-2\nLanguage:Spanish</div><div class="torrent-file-list"><ul><li><i></i>movie.zh-Hans.ass <span>3 KiB</span></li></ul></div>';
  assert.deepEqual(readNyaaSubtitleDetails(body), { languages:['EN','FR','ES'], sidecars:['CHS'], multiple:false, hasSubtitles:true });
  assert.deepEqual(inferRelease('Movie.BD.VF.VOSTFR.{EN.ESP.SUBS}.DTS').languages, ['EN','ES','FR']);
  assert.deepEqual(inferRelease('Movie [Dual Audio] [Multi Subs]').languages, []);
});
