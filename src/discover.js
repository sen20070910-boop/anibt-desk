import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { load } from 'cheerio/slim';
import { randomBytes } from 'node:crypto';
import { Converter } from 'opencc-js/t2cn';
import { parseFeed } from './feed.js';
import { normalizeHash, magnetHash, torrentInfoHash } from './torrent.js';
import { createSourceNetwork, sourceUrl } from './source-network.js';
import { hasMultipleSubtitles, hasVideoExtension, subtitleLanguageCode, titleSubtitleCodes } from './subtitle-language.js';
import { nyaaSubtitlePage, readNyaaSubtitleDetails } from './nyaa-subtitles.js';
import { sourceLinks as historyLinks } from './history-actions.js';
import { singleEpisode, episodeInReleaseTitle } from './episodes.js';
import { bangumiNames, findBangumi } from './bangumi-catalog.js';

export const sourceNames = {
  anibt: 'AniBT',
  garden: 'Anime Garden',
  mikan: '蜜柑计划',
  dmhy: '动漫花园',
  nyaa: 'Nyaa',
  vcb: 'VCB-S 作品',
  acg: 'ACG.RIP',
  nekobt: 'nekoBT',
  moe: '萌番组',
  seadex: 'SeaDex',
};
const mikanBase = 'https://mikanime.tv/';
const gardenBase = 'https://animes.garden/';
const array=x=>x==null?[]:Array.isArray(x)?x:[x];
const str=x=>typeof x==='object'&&x?String(x['#text']||''):String(x??'');
const xml=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:true});
const clean=x=>load(String(x||'')).text().replace(/\s+/g,' ').trim();
export function inferRelease(title,description='') {
  const text=title+' '+description;const languages=titleSubtitleCodes(text);
  if(/简|簡|\bCHS\b|\bGB\b|\bGB2312\b|\bSC\b/i.test(text))languages.push('CHS');
  if(/繁|\bCHT\b|\bBIG5\b|\bTC\b/i.test(text))languages.push('CHT');
  if(/\[(?:EN|ENG|English)\]|English\s+(?:subs?|subtitles?)|英[文语語]字幕/i.test(text))languages.push('EN');
  const workTitle = releaseWorkTitle(title);
  return{workTitle,groupName:title.match(/^[\[【]([^\]】]+)[\]】]/)?.[1]||'',languages:[...new Set(languages)],resolution:title.match(/\b(2160p|1080p|720p|480p|4K)\b/i)?.[1]?.toLowerCase()||'',subtitles:/内封|內封/.test(text)?['INTERNAL']:/内嵌|內嵌/.test(text)?['EMBEDDED']:/外挂|外掛/.test(text)?['EXTERNAL']:[]};
}
const technicalTag = /^(?:\d{1,2}[ -]?bit|(?:2160|1080|720|480)[pi]|(?:1920|1280)[x×](?:1080|720)|4K|BD(?:Rip|Remux)?|Blu[ -]?Ray|UHD|WEB(?:[ -]?(?:DL|Rip))?|DVD(?:Rip)?|HEVC|AVC|AV1|[xh][ .]?26[45]|Dual[ -]?Audio|Multi(?:ple)?[ -]?Subs?|[A-F0-9]{8}|Fin|END|Reseed|CHS|CHT)(?![\p{L}\p{N}])/iu;
export function releaseWorkTitle(title) {
  const name = title.replace(/^[\[【][^\]】]+[\]】]\s*/, '').replace(/\.(?:mkv|mp4|avi|mov|m2ts|ts|webm|torrent)$/i, '').trim();
  let end = name.length;
  for (const match of name.matchAll(/[\[【(（]([^\]】)）]*)[\]】)）]?/gu)) {
    if (!match.index) continue;
    const tag = match[1].trim();
    if (technicalTag.test(tag) || /^\d{1,3}(?:v\d+)?$/i.test(tag)) {
      end = match.index;
      break;
    }
  }
  const spaced = name.slice(0, end).replace(/\s+(?:\d+[ -]?bit|(?:2160|1080|720|480)[pi]|BDRip|BluRay|WebRip|WEB-DL|HEVC|AVC|x26[45])\b.*$/i, '')
    .replace(/\s+-\s+\d{1,3}(?:v\d+)?\b.*$/i, '').trim();
  // Some release teams use dots between all words and technical fields.
  const dotted = /\.(?:19|20)\d{2}(?=\.(?:BluRay|BDRip|WEB|\d{3,4}p)\b)/i.exec(spaced)
    || /\.(?:BluRay|BDRip|WEB(?:-DL|Rip)?|(?:2160|1080|720|480)p)\b/i.exec(spaced);
  return (dotted ? spaced.slice(0, dotted.index).replaceAll('.', ' ') : spaced) || title;
}
function validPage(url,base){if(typeof url!=='string'||!url.trim())return '';try{return sourceUrl(url,base);}catch{return '';}}
function sizeBytes(text){const m=String(text).match(/([\d.]+)\s*([KMGT]?i?B)/i);if(!m)return 0;const power={B:0,K:1,M:2,G:3,T:4}[m[2][0].toUpperCase()]||0;return Number(m[1])*(/i/i.test(m[2])?1024:1000)**power;}
function byteLabel(bytes) {
  return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB'
    : bytes > 0 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : '';
}
function count(value) {
  const n = Number(value);
  return value !== '' && value != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const nyaaTracker = 'https://nyaa.tracker.wf/announce';
const nekoTracker = 'https://tracker.nekobt.to/api/tracker/public/announce';
const magnetFor = (hash, tracker) => 'magnet:?xt=urn:btih:' + hash + (tracker ? '&tr=' + encodeURIComponent(tracker) : '');
const publicNekoTorrent = id => 'https://nekobt.to/api/v1/torrents/' + id + '/download?public=true';
const moeTorrent = id => 'https://bangumi.moe/download/torrent/' + id + '/anibt.torrent';

export function parseAcgRip(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    throw new Error('ACG.RIP 返回了无法识别的 RSS。');
  const channel = xml.parse(text)?.rss?.channel;
  if (!channel) throw new Error('ACG.RIP 没有返回资源列表。');
  return array(channel.item).flatMap(raw => {
    const title = str(raw.title);
    const pageUrl = validPage(str(raw.link), 'https://acg.rip/');
    const id = pageUrl && /^https:\/\/acg\.rip\/t\/(\d+)$/.exec(pageUrl)?.[1];
    if (!title || !id) return [];
    const bytes = count(raw['torrent:contentLength'] ?? raw['media:content']?.['@_fileSize']) || 0;
    const infoHash = normalizeHash(str(raw['torrent:infoHash']));
    return [{
      ...inferRelease(title), title, pageUrl, infoHash, magnet: '',
      torrentUrl: pageUrl + '.torrent', sizeBytes: bytes, sizeText: byteLabel(bytes),
      seeders: null, publishedAt: str(raw.pubDate), source: 'acg', kind: 'release',
    }];
  });
}

export function parseMoe(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.torrents) || data.success === false)
    throw new Error('萌番组没有返回可识别的资源列表。');
  return data.torrents.flatMap(raw => {
    if (raw?.category_tag_id !== '549ef207fe682f7549f1ea90' ||
        !/^[a-f0-9]{24}$/i.test(raw._id ?? '') || typeof raw.title !== 'string' || !raw.title.trim()) return [];
    const title = raw.title.trim();
    const release = inferRelease(title);
    const infoHash = normalizeHash(raw.infoHash);
    const sizeText = typeof raw.size === 'string' ? raw.size : '';
    return [{
      ...release, title, groupName: typeof raw.team?.name === 'string' ? raw.team.name : release.groupName,
      infoHash, magnet: infoHash && magnetHash(raw.magnet) === infoHash ? raw.magnet : '',
      torrentUrl: moeTorrent(raw._id), pageUrl: 'https://bangumi.moe/torrent/' + raw._id,
      sizeText, sizeBytes: sizeBytes(sizeText), seeders: count(raw.seeders),
      publishedAt: raw.publish_time, source: 'moe', kind: 'release',
    }];
  });
}

function languageCodes(tags) {
  return typeof tags === 'string' ? tags.split(',').map(value => {
    const tag = value.trim();
    return subtitleLanguageCode(tag) || (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) ? tag.split('-')[0].toUpperCase() : '');
  }).filter(Boolean) : [];
}
export function parseNekoBt(text) {
  const data = JSON.parse(text);
  if (data?.error !== false || !Array.isArray(data.data?.results))
    throw new Error('nekoBT 没有返回可识别的资源列表。');
  return data.data.results.flatMap(raw => {
    const infoHash = normalizeHash(raw?.infohash);
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    if (!title || !infoHash || !/^\d{1,20}$/.test(raw.id ?? '') || raw.hidden || raw.deleted) return [];
    const release = inferRelease(title);
    const numbered = release.workTitle.match(/\b(S\d{1,2})E(\d{1,4})(?:v(\d+))?([-~]E?\d{1,4})?\b/i);
    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    const group = groups.find(group => group?.uploading_group) || groups[0];
    const bytes = count(raw.filesize) || 0;
    const date = new Date(Number(raw.uploaded_at));
    return [{
      ...release, title, groupName: typeof group?.display_name === 'string' ? group.display_name : release.groupName,
      workTitle: numbered ? release.workTitle.replace(numbered[0], numbered[1].toUpperCase()) : release.workTitle,
      episode: numbered && !numbered[4] && raw.batch === false ? numbered[2] : '',
      version: numbered?.[3] ? 'v' + numbered[3] : 'v1',
      languages: [...new Set([...release.languages, ...languageCodes(raw.sub_lang), ...languageCodes(raw.fsub_lang)])],
      audioLanguages: [...new Set(languageCodes(raw.audio_lang))],
      infoHash, magnet: magnetHash(raw.magnet) === infoHash ? raw.magnet : magnetFor(infoHash, nekoTracker),
      torrentUrl: publicNekoTorrent(raw.id), pageUrl: 'https://nekobt.to/torrents/' + raw.id,
      sizeText: byteLabel(bytes), sizeBytes: bytes, seeders: count(raw.seeders),
      publishedAt: Number.isFinite(+date) && +date > 0 ? date.toISOString() : '',
      source: 'nekobt', kind: 'release',
    }];
  });
}
export function parseNyaa(text) {
  if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('Nyaa 返回了无法识别的内容。');
  const channel=xml.parse(text)?.rss?.channel;if(!channel)throw new Error('Nyaa 没有返回资源列表。');
  return array(channel.item).map(raw=>{const title=str(raw.title),hash=normalizeHash(raw['nyaa:infoHash']),pageUrl=validPage(str(raw.guid)||str(raw.link),'https://nyaa.si/');return{title,...inferRelease(title),infoHash:hash,magnet:hash?'magnet:?xt=urn:btih:'+hash+'&tr=https%3A%2F%2Fnyaa.tracker.wf%2Fannounce':'',torrentUrl:validPage(str(raw.link),'https://nyaa.si/'),pageUrl,sizeText:str(raw['nyaa:size']),sizeBytes:sizeBytes(raw['nyaa:size']),seeders:raw['nyaa:seeders']!==undefined?Number(raw['nyaa:seeders']):null,publishedAt:str(raw.pubDate),source:'nyaa',kind:'release'};}).filter(i=>i.title&&(i.infoHash||i.torrentUrl));
}
export function parseDmhy(text) {
  const $=load(text);const rows=$('#topic_list tbody tr');if(!$('#topic_list').length)throw new Error('动漫花园没有返回可识别的资源列表。');
  return rows.map((_,row)=>{const r=$(row),cells=r.children('td');const anchor=r.find('td.title>a[href*="/topics/view/"]').first();const title=anchor.text().trim();const magnet=r.find('a[href^="magnet:"]').first().attr('href')||r.find('[data-magnet]').first().attr('data-magnet')||'';const published=cells.eq(0).text().match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/)?.[0];const sizeText=cells.eq(4).text().trim();const seeds=cells.eq(5).text().trim();return{title,...inferRelease(title),groupName:r.find('td.title .tag').text().trim()||inferRelease(title).groupName,infoHash:magnetHash(magnet),magnet,torrentUrl:'',pageUrl:validPage(anchor.attr('href'),'https://www.dmhy.org/'),sizeText,sizeBytes:sizeBytes(sizeText),seeders:/^\d+$/.test(seeds)?Number(seeds):null,publishedAt:published?published.replaceAll('/','-').replace(' ','T')+':00+08:00':'',source:'dmhy',kind:'release'};}).get().filter(i=>i.title&&i.infoHash);
}
export function parseAnimeGarden(text) {
  const data = JSON.parse(text);
  if (data?.status !== 'OK' || !Array.isArray(data.resources)) {
    throw new Error('Anime Garden 没有返回可识别的资源列表。');
  }
  return data.resources.flatMap(raw => {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    const infoHash = magnetHash(raw?.magnet);
    if (!title || !infoHash) return [];
    const { provider, providerId } = raw;
    const origin = validPage(raw.href);
    const pageUrl = /^[a-z0-9_-]+$/i.test(provider ?? '') && /^[a-z0-9_-]+$/i.test(providerId ?? '')
      ? new URL('detail/' + provider + '/' + providerId, gardenBase).href
      : origin;
    const release = inferRelease(title);
    const bytes = Number.isFinite(raw.size) && raw.size > 0 ? raw.size : 0;
    const sizeText = bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB'
      : bytes ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : '';
    const magnet = new URL(raw.magnet);
    const trackers = new Set(magnet.searchParams.getAll('tr'));
    for (const value of new URLSearchParams(typeof raw.tracker === 'string' ? raw.tracker : '').getAll('tr').slice(0, 40)) {
      if (!trackers.has(value) && /^(?:https?|udp):\/\//i.test(value)) {
        magnet.searchParams.append('tr', value);
        trackers.add(value);
      }
    }
    return [{
      title, ...release, groupName: raw.fansub?.name || release.groupName,
      infoHash, magnet: magnet.href, torrentUrl: '', pageUrl, sizeText, sizeBytes: bytes,
      seeders: null, publishedAt: raw.createdAt || '', source: 'garden', kind: 'release',
      links: [
        { source: 'garden', url: pageUrl },
        ...(origin && origin !== pageUrl ? [{ source: Object.hasOwn(sourceNames, provider) ? provider : 'garden', url: origin }] : []),
      ],
    }];
  });
}
function mikanPublishedAt(value, now) {
  const stamp = value.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}:\d{2})/);
  if (stamp) return stamp.slice(1, 4).join('-') + 'T' + stamp[4] + ':00+08:00';
  const relative = value.match(/^(今天|昨天|前天)\s+(\d{2}:\d{2})/);
  if (!relative) return '';
  const day = new Date(now + 8 * 3600000 - ['今天', '昨天', '前天'].indexOf(relative[1]) * 86400000);
  return day.toISOString().slice(0, 10) + 'T' + relative[2] + ':00+08:00';
}
export function parseMikan(text, now = Date.now()) {
  const $ = load(text);
  const tables = $('table.tbl-border');
  if (!tables.length) {
    if (/找不到对应结果|找不到對應結果/.test($('body').text())) return [];
    throw new Error('蜜柑计划没有返回可识别的资源列表。');
  }
  return tables.find('tbody tr').map((_, row) => {
    const r = $(row);
    const detail = r.find('a[href]').filter((_, a) => /\/home\/episode\//i.test($(a).attr('href'))).first();
    const title = detail.text().trim();
    if (!title) return null;
    const magnet = r.find('[data-magnet]').first().attr('data-magnet')
      || r.find('[data-clipboard-text^="magnet:"]').first().attr('data-clipboard-text')
      || r.find('a[href^="magnet:"]').first().attr('href') || '';
    const infoHash = magnetHash(magnet);
    const torrent = r.find('a[href]').filter((_, a) => /^\/download\/.*\.torrent$/i.test($(a).attr('href'))).first();
    const torrentUrl = validPage(torrent.attr('href'), mikanBase);
    if (!infoHash && !torrentUrl) return null;
    const release = inferRelease(title);
    const group = r.find('a[href]').filter((_, a) => /\/home\/publishgroup\//i.test($(a).attr('href'))).first();
    const sizeText = detail.closest('td').next().text().trim();
    const publishedAt = r.children('td').toArray().map(td => mikanPublishedAt($(td).text().trim(), now)).find(Boolean) || '';
    return {
      title, ...release, groupName: group.text().trim() || release.groupName,
      infoHash, magnet: infoHash ? magnet : '', torrentUrl,
      pageUrl: validPage(detail.attr('href'), mikanBase), sizeText, sizeBytes: sizeBytes(sizeText),
      seeders: null, publishedAt, source: 'mikan', kind: 'release',
    };
  }).get();
}
export function parseVcbProjects(text,base='https://vcb-s.com/') {
  const $=load(text);let nodes=$('article');if(!nodes.length)nodes=$('.post');
  return nodes.map((_,node)=>{const p=$(node),link=p.find('.entry-title a,h1 a,h2 a').first();const title=link.text().trim();if(!/BDRip|BluRay|HEVC|AVC|作品|项目/i.test(title))return null;const description=clean(p.find('.entry-content,.entry-summary').text()).slice(0,180);const magnet=p.find('a[href^="magnet:"]').first().attr('href')||'';return{title,...inferRelease(title),groupName:'VCB-Studio',infoHash:magnetHash(magnet),magnet,torrentUrl:'',pageUrl:validPage(link.attr('href'),base),sizeText:'',sizeBytes:0,seeders:null,publishedAt:p.find('time').attr('datetime')||'',description,source:'vcb',kind:'project'};}).get().filter(i=>i?.title&&i.pageUrl);
}
export function mergeReleases(items) {
  const map=new Map();
  for (const item of items) {
    const key = item.infoHash ? 'hash:' + item.infoHash : 'page:' + item.pageUrl;
    if (!map.has(key)) map.set(key, { ...item, sources: [], links: [] });
    const entry = map.get(key);
    if (!entry.sources.includes(item.source)) entry.sources.push(item.source);
    for (const link of item.links?.length ? item.links : [{ source: item.source, url: item.pageUrl }]) {
      if (link.url && !entry.links.some(existing => existing.url === link.url)) entry.links.push(link);
    }
    if (item.torrentUrl && !entry.torrentUrl) entry.torrentUrl = item.torrentUrl;
    if (item.magnet && !entry.magnet) entry.magnet = item.magnet;
    if (item.seeders != null) entry.seeders = Math.max(entry.seeders || 0, item.seeders);
    entry.languages = [...new Set([...entry.languages, ...item.languages])];
    if (item.audioLanguages?.length)
      entry.audioLanguages = [...new Set([...(entry.audioLanguages || []), ...item.audioLanguages])];
    if (item.seadexRating && entry.seadexRating !== 'best') entry.seadexRating = item.seadexRating;
    if (!entry.sizeText && item.sizeText) {
      entry.sizeText = item.sizeText;
      entry.sizeBytes = item.sizeBytes;
    }
    if (item.kind === 'project') entry.kind = 'project';
  }
  return[...map.values()].sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
}
const titleKey = title => title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
let simplify;
const simplifiedTitle = title => (simplify ??= Converter({ from: 't', to: 'cn' }))(title);
const catalogKey = title => titleKey(simplifiedTitle(title));
function publicTorrent(page) {
  const url = new URL(page);
  const id = url.pathname.split('/').at(-1);
  if (url.hostname === 'nyaa.si' && /^\/view\/\d+$/.test(url.pathname))
    return { torrentUrl: 'https://nyaa.si/download/' + id + '.torrent', tracker: nyaaTracker, source: 'nyaa' };
  if (url.hostname === 'nekobt.to' && /^\/torrents\/\d+$/.test(url.pathname))
    return { torrentUrl: publicNekoTorrent(id), tracker: nekoTracker, source: 'nekobt' };
  if (url.hostname === 'acg.rip' && /^\/t\/\d+$/.test(url.pathname))
    return { torrentUrl: url.origin + url.pathname + '.torrent', source: 'acg' };
  if (url.hostname === 'bangumi.moe' && /^\/torrent\/[a-f0-9]{24}$/i.test(url.pathname))
    return { torrentUrl: moeTorrent(id), source: 'moe' };
  return null;
}
export function parseSeaDex(text, titles = new Map()) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.items)) throw new Error('SeaDex 没有返回可识别的推荐列表。');
  return data.items.flatMap(entry => {
    const versions = entry?.expand?.trs;
    if (!Array.isArray(versions)) return [];
    return versions.flatMap(raw => {
      const infoHash = normalizeHash(raw?.infoHash);
      const pageUrl = validPage(raw?.url);
      const download = pageUrl && publicTorrent(pageUrl);
      if (!infoHash || !download) return [];
      const files = Array.isArray(raw.files) ? raw.files : [];
      const video = files.filter(file => typeof file?.name === 'string' && hasVideoExtension(file.name));
      const filename = video[0]?.name.split(/[\\/]/).at(-1) || '';
      const groupName = typeof raw.releaseGroup === 'string' ? raw.releaseGroup : '';
      const inferred = inferRelease(filename.replace(/\.[^.]+$/, '').replaceAll('.', ' ')).workTitle
        .replace(/\bS(\d{1,2})E\d+\b.*$/i, (_, season) => Number(season) === 1 ? '' : 'Season ' + Number(season)).trim();
      const workTitle = titles.get(entry.alID) || inferred;
      if (!workTitle) return [];
      const resolution = filename.match(/(?:2160|1080|720|480)p/i)?.[0]?.toLowerCase()
        || (/[x×]1080\b/i.test(filename) ? '1080p' : '');
      const bytes = files.reduce((sum, file) => sum + (count(file?.length) || 0), 0);
      return [{
        title: (groupName ? '[' + groupName + '] ' : '') + workTitle + (video.length > 1 ? ' · ' + video.length + ' 个视频' : ''),
        workTitle, groupName, anilistId: entry.alID, languages: titleSubtitleCodes(filename), subtitles: [], resolution,
        infoHash, magnet: magnetFor(infoHash, download.tracker), torrentUrl: download.torrentUrl, pageUrl,
        sizeBytes: bytes, sizeText: byteLabel(bytes), seeders: null, publishedAt: entry.updated,
        source: 'seadex', kind: 'release', seadexRating: raw.isBest === true ? 'best' : 'alt',
        links: [{ source: download.source, url: pageUrl }, { source: 'seadex', url: 'https://seadex.moe/' }],
      }];
    });
  });
}
function seasonSuffix(title) {
  const normalized = title.normalize('NFKC');
  const match = normalized.match(/(?:\s*第\s*([一二三四五六七八九十两兩\d]{1,3})\s*[季期]|\s+(?:s(\d{1,2})|season\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+season))$/i);
  if (!match || !match.index) return null;
  const digits = '零一二三四五六七八九';
  const value = (match[1] || match[2] || match[3] || match[4]).replace(/[两兩]/g, '二');
  let number = Number(value);
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    number = 10 * (tens ? digits.indexOf(tens) : 1) + (units ? digits.indexOf(units) : 0);
  } else if (value.length === 1 && digits.includes(value)) number = digits.indexOf(value);
  return number > 0 ? { title: normalized.slice(0, match.index).trim(), number } : null;
}
const yearSuffix = /\s*\((?:19|20)\d{2}\)$/;
function catalogNames(row) {
  const { title, titleChinese, titleRomaji } = row;
  return [...(row.aliases || []), title?.chinese, title?.chineseTraditional, titleChinese, title?.native || title?.japanese,
    title?.romaji || titleRomaji, title?.english].filter(name => typeof name === 'string' && name.trim());
}
function matchingCatalogNames(page, query, season) {
  const requestedKey = catalogKey(query);
  const key = catalogKey(season?.title || query);
  const matches = new Map();
  for (const row of page) {
    if (!row || typeof row !== 'object') continue;
    const names = catalogNames(row);
    if (!names.some(name => catalogKey(name) === requestedKey)) {
      if (!season) continue;
      const group = names.map(seasonSuffix).filter(Boolean);
      if (season.number === 1 ? group.some(s => s.number !== 1) : !group.some(s => s.number === season.number)) continue;
      if (!names.some(name => catalogKey(seasonSuffix(name)?.title || name.replace(yearSuffix, '')) === key)) continue;
    }
    const usable = season?.number > 1 ? names.filter(name => seasonSuffix(name)?.number === season.number || yearSuffix.test(name)) : names;
    if (usable.length) matches.set(String(row.bgmId ?? row._id ?? names.join('|')), usable);
  }
  return matches.size === 1 ? matches.values().next().value : [];
}

// AniBT supplies the first and second names. Keep the common simplified
// spelling of the Taiwanese title usable even when the catalog is offline.
const knownTitleGroups = [
  ['药屋少女的呢喃', '藥師少女的獨語', '药师少女的独语', '薬屋のひとりごと', 'The Apothecary Diaries', 'Kusuriya no Hitorigoto'],
];
function distinctAliases(query, names, limit = 3) {
  const seen = new Set([titleKey(query)]);
  const result = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const title = name.trim();
    const key = titleKey(title);
    if (!key || seen.has(key) || Buffer.byteLength(title) > 150) continue;
    seen.add(key);
    result.push(title);
    if (result.length === limit) break;
  }
  return result;
}
export function createDiscovery(getPreferences,{network=createSourceNetwork(getPreferences),now=()=>Date.now()}={}) {
  const cache=new Map(),results=new Map();
  const remember=item=>{const id=randomBytes(16).toString('hex');results.set(id,{item,at:now()});return{resultId:id,title:item.title,workTitle:item.workTitle,bgmId:item.bgmId,anilistId:item.anilistId,groupName:item.groupName,episode:singleEpisode(item.episode)||(!item.episode&&item.kind!=='project'?episodeInReleaseTitle(item.title):null),languages:item.languages,audioLanguages:item.audioLanguages,seadexRating:item.seadexRating,resolution:item.resolution,subtitles:item.subtitles,sizeText:item.sizeText,sizeBytes:item.sizeBytes,seeders:item.seeders,publishedAt:item.publishedAt,sources:item.sources,links:item.links,kind:item.kind,downloadable:!!(item.infoHash||item.torrentUrl||item.kind==='project'),description:item.description||'',infoHash:item.infoHash,multipleSubtitles:hasMultipleSubtitles(item.title),subtitleLookup:!!nyaaSubtitlePage(item)};};
  const memo=(key,run,force)=>{key=network.cacheKey()+'|'+key;const old=cache.get(key);if(old&&(old.pending||!force&&now()-old.at<120000))return old.promise;const promise=run();const entry={at:now(),promise,pending:true};cache.set(key,entry);promise.then(()=>entry.pending=false,()=>{if(cache.get(key)?.promise===promise)cache.delete(key);});return promise;};
  async function provider(source,query,force=false) {
    return memo(source+'|'+query,async()=>{
      let url,parser;
      if(source==='anibt'){url=new URL('https://anibt.net/rss/magnets.xml');url.searchParams.set('limit','60');if(query)url.searchParams.set('q',query);parser=text=>parseFeed(text).map(i=>({...i,...inferRelease(i.title),languages:i.languages.length?i.languages:inferRelease(i.title).languages,groupName:i.groupName||inferRelease(i.title).groupName,resolution:i.resolution||inferRelease(i.title).resolution,workTitle:i.animeTitle||inferRelease(i.title).workTitle,pageUrl:'https://anibt.net/release/'+encodeURIComponent(i.id),sizeText:'',sizeBytes:0,seeders:null,source:'anibt',kind:'release'}));}
      if (source === 'garden') {
        url = new URL('https://api.animes.garden/resources?pageSize=100&type=动画&tracker=true');
        if (query) url.searchParams.set('search', query);
        parser = parseAnimeGarden;
      }
      if (source === 'mikan') {
        url = new URL(query ? 'Home/Search' : 'Home/Classic', mikanBase);
        if (query) url.searchParams.set('searchstr', query);
        parser = text => parseMikan(text, now());
      }
      if(source==='dmhy'){url=new URL('https://www.dmhy.org/topics/list');if(query)url.searchParams.set('keyword',query);parser=parseDmhy;}
      if(source==='nyaa'){url=new URL('https://nyaa.si/');url.searchParams.set('page','rss');url.searchParams.set('c','1_0');url.searchParams.set('f','0');if(query)url.searchParams.set('q',query);parser=parseNyaa;}
      if (source === 'acg') {
        url = new URL('https://acg.rip/.xml');
        if (query) url.searchParams.set('term', query);
        parser = parseAcgRip;
      }
      if (source === 'moe') {
        url = new URL('https://bangumi.moe/api/v2/torrent/' + (query ? 'search' : 'page/1'));
        url.searchParams.set('limit', '50');
        if (query) {
          url.searchParams.set('p', '1');
          url.searchParams.set('query', query);
        }
        parser = parseMoe;
      }
      if (source === 'nekobt') {
        url = new URL('https://nekobt.to/api/v1/torrents/search');
        url.searchParams.set('limit', '50');
        if (query) url.searchParams.set('query', query);
        parser = parseNekoBt;
      }
      if (!url) throw new Error('不支持的来源。');
      const first = await network.read(url.href);
      const items = parser(first.text);
      let via = first.via, message = '';
      if (query && ((source === 'garden' && items.length >= 100) ||
          (source === 'dmhy' && load(first.text)('a[href^="/topics/list/page/2?"]').length))) {
        // The older search page is part of the same public query. Keep the
        // first page if loading more fails.
        if (source === 'garden') url.searchParams.set('page', '2');
        else url.pathname = '/topics/list/page/2';
        try {
          const older = await network.read(url.href);
          items.push(...parser(older.text));
          via = [...new Set([via, older.via].filter(Boolean))].join(' / ');
        } catch {
          message = '后续搜索页暂时无法读取，已保留首批结果。';
        }
      }
      return {items, via, state: 'ok', message};
    },force);
  }
  async function titleAliases(query, force, season) {
    const title = season?.title || query;
    const key = catalogKey(title);
    if (key.length < 2) return [];
    const known = !season || season.number === 1
      ? knownTitleGroups.find(group => group.some(name => catalogKey(name) === key)) : null;
    if (known) return distinctAliases(season?.number === 1 ? title : query, known, 4);
    for (const term of new Set([title, simplifiedTitle(title)])) {
      try {
        const page = await memo('title-alias-catalog|' + term, async () => {
          const url = 'https://anibt.net/api/animes/search?' + new URLSearchParams({ q: term, limit: '16' });
          const { text } = await network.read(url, { maxBytes: 1_000_000, timeoutMs: 3500 });
          const { page } = JSON.parse(text);
          return Array.isArray(page) ? page : [];
        }, force);
        const names = matchingCatalogNames(page, query, season);
        if (names.length) return distinctAliases(season?.number === 1 ? title : query, names);
      } catch {}
    }
    try {
      const names = await memo('title-alias-bangumi|' + query, () => findBangumi(network, query, rows => {
        const page = rows.map(row => ({ bgmId: row.id, aliases: bangumiNames(row) }));
        const matched = matchingCatalogNames(page, query, season);
        return matched.length ? matched : null;
      }), force);
      if (names?.length) return distinctAliases(season?.number === 1 ? title : query, names);
    } catch {}
    const original = season?.number === 1 ? title : query;
    return distinctAliases(original, [simplifiedTitle(original)]);
  }
  async function searchProvider(source, query, aliases, force, firstSeason) {
    if (source === 'vcb') return vcb(firstSeason || query, force, await aliases);
    if (source === 'seadex') return seaDex(query, await aliases, force);
    const original = Promise.allSettled([provider(source, query, force)]);
    const terms = [...await aliases];
    if (firstSeason && source === 'nyaa') {
      const latinName = terms.find(name => /^[\x20-\x7e]+$/.test(name) && /[a-z]/i.test(name));
      if (latinName && latinName.length + 4 <= 150) {
        const numbered = latinName + ' S01';
        if (catalogKey(query) !== catalogKey(numbered) && !terms.some(term => catalogKey(term) === catalogKey(numbered)))
          terms.push(numbered);
      }
    }
    const variants = Promise.allSettled(terms.map(term => provider(source, term, force)));
    const [[primary], extra] = await Promise.all([original, variants]);
    const available = [primary, ...extra].filter(response => response.status === 'fulfilled').map(response => response.value);
    if (!available.length) throw primary.reason;
    return {
      items: terms.length ? mergeReleases(available.flatMap(response => response.items)) : available[0].items,
      via: [...new Set(available.map(response => response.via).filter(Boolean))].join(' / '),
      state: 'ok',
      message: [...new Set([
        ...available.map(response => response.message),
        available.length < terms.length + 1 ? '部分关键词查询未完成，已显示成功返回的结果。' : '',
      ].filter(Boolean))].join(' '),
    };
  }
  async function seaDex(query, aliases, force) {
    const terms = [...new Set([query, ...aliases].filter(Boolean))].slice(0, 5);
    return memo('seadex|' + JSON.stringify(terms), async () => {
      const titles = new Map();
      const paths = [];
      if (terms.length) {
        const variables = Object.fromEntries(terms.map((term, i) => ['q' + i, term]));
        const declaration = Object.keys(variables).map(key => '$' + key + ':String!').join(',');
        const fields = Object.keys(variables).map(key =>
          key + ':Page(perPage:5){media(type:ANIME,search:$' + key + '){id title{romaji english native} synonyms}}').join(' ');
        const response = await network.read('https://graphql.anilist.co/', {
          jsonBody: { query: 'query(' + declaration + '){' + fields + '}', variables },
          maxBytes: 400_000, timeoutMs: 5500,
        });
        paths.push(response.via);
        const { data } = JSON.parse(response.text);
        if (!data) throw new Error('AniList 没有返回可识别的作品列表。');
        const keys = terms.map(catalogKey);
        for (const { media } of Object.values(data).filter(page => Array.isArray(page?.media))) {
          for (const row of media) {
            if (!Number.isSafeInteger(row?.id) || row.id <= 0) continue;
            const names = [row.title?.english, row.title?.romaji, row.title?.native,
              ...(Array.isArray(row.synonyms) ? row.synonyms : [])].filter(name => typeof name === 'string' && name.trim());
            if (names.length && names.some(name => keys.includes(catalogKey(name)))) titles.set(row.id, names[0]);
          }
        }
        if (!titles.size) return { items: [], via: response.via, state: 'ok', message: '未匹配到可核对的 AniList 作品名称。' };
      }
      const url = new URL('https://seadex.moe/api/collections/entries/records');
      url.search = new URLSearchParams({ expand: 'trs', sort: '-updated', perPage: '8', skipTotal: 'true' });
      if (titles.size) url.searchParams.set('filter', [...titles.keys()].slice(0, 8).map(id => 'alID=' + id).join(' || '));
      const response = await network.read(url.href, { maxBytes: 4_000_000, timeoutMs: 7000 });
      paths.push(response.via);
      const items = parseSeaDex(response.text, titles);
      return {
        items, state: 'ok', via: [...new Set(paths.filter(Boolean))].join(' / '),
        message: query && !items.length ? '匹配作品暂无可用的公开推荐版本。' : '',
      };
    }, force);
  }
  async function vcb(query, force, aliases) {
    const terms = [...new Set([query, ...aliases])];
    return memo('vcb|' + JSON.stringify(terms), async () => {
      let reason = '官网本次没有返回可识别的作品项目。';
      for (const term of terms.slice(0, 2)) {
        try {
          const url = new URL('https://vcb-s.com/');
          if (term) url.searchParams.set('s', term);
          const r = await network.read(url.href);
          const items = parseVcbProjects(r.text, r.url);
          if (items.length) return { items, via: r.via, state: 'ok' };
        } catch (e) {
          reason = e.code === 'BROWSER_REQUIRED' ? '官网需要浏览器验证。' : e.message;
          break;
        }
      }
      const group = /VCB[- ]?Studio/i;
      const q = group.test(query) ? query : ('VCB-Studio ' + query).trim();
      const requests = [['dmhy', q], ['nyaa', q]];
      for (const term of terms) requests.push(['garden', term || q], ['mikan', term || q]);
      const fallback = await Promise.allSettled(requests.map(([source, term]) => provider(source, term, force)));
      const available = fallback.flatMap((r, index) => r.status === 'fulfilled'
        ? [{ ...r.value, source: requests[index][0] }] : []);
      if (!available.length) throw new Error(reason + ' 公开发布站也暂时不可用。');
      const items = available.flatMap(r => r.items).filter(item => group.test(item.title) || group.test(item.groupName))
        .map(item => ({
          ...item, source: 'vcb', kind: 'project',
          links: item.links?.length ? item.links : [{ source: item.source, url: item.pageUrl }],
        }));
      return {
        items: mergeReleases(items), state: 'fallback',
        via: [...new Set(available.map(r => r.via).filter(Boolean))].join(' / '),
        message: reason + ' 已查询 ' + [...new Set(available.map(r => sourceNames[r.source]))].join(' / ') + ' 的 VCB-Studio 公开发行资源。',
      };
    }, force);
  }
  async function search({query='',sources=Object.keys(sourceNames),refresh=false,fuzzy=true}={}) {
    query=String(query).trim().replace(/\s+/g,' ');if(Buffer.byteLength(query)>150)throw new Error('搜索词过长，请缩短到 150 字节以内。');if(!Array.isArray(sources)||!sources.length||sources.some(s=>!Object.hasOwn(sourceNames,s)))throw new Error('请选择有效的资源来源。');sources=[...new Set(sources)];
    for(const[id,entry]of results)if(now()-entry.at>1800000)results.delete(id);
    for(const[key,entry]of cache)if(!entry.pending&&now()-entry.at>120000)cache.delete(key);
    const season = fuzzy ? seasonSuffix(query) : null;
    const firstSeason = season?.number === 1 ? season.title : '';
    const aliases = fuzzy && query
      ? titleAliases(query, refresh, season).then(names => [...new Set(firstSeason ? [firstSeason, ...names] : names)])
      : Promise.resolve(firstSeason ? [firstSeason] : []);
    const responses=await Promise.all(sources.map(async source=>{
      const start=now();
      try{
        const r=await searchProvider(source,query,aliases,refresh,firstSeason);
        const items=r.items;
        return{source,name:sourceNames[source],state:r.state,message:r.message||'',via:r.via,count:items.length,elapsedMs:now()-start,items};
      }catch(e){
        return{source,name:sourceNames[source],state:e.code==='BROWSER_REQUIRED'?'browser-required':'error',message:e.message,count:0,elapsedMs:now()-start,items:[]};
      }
    }));
    const merged = mergeReleases(responses.flatMap(r => r.items));
    return {items: merged.map(remember), providers: responses.map(({items, ...status}) => status),
      query, aliases: await aliases, fetchedAt: new Date(now()).toISOString(), total: merged.length, truncated: false};
  }
  async function resolve(id) {
    const entry=results.get(id);if(!entry||now()-entry.at>1800000)throw new Error('这条搜索结果已过期，请重新搜索。');let item={...entry.item};
    if(!item.infoHash&&item.kind==='project'){
      const r=await network.read(item.pageUrl);const $=load(r.text);const magnets=$('a[href^="magnet:"]').map((_,e)=>$(e).attr('href')).get();const magnet=magnets.find(m=>magnetHash(m));if(magnet)item={...item,magnet,infoHash:magnetHash(magnet)};
      if(!item.infoHash){const links=$('a[href]').map((_,e)=>validPage($(e).attr('href'),item.pageUrl)).get().filter(Boolean);const torrent=links.find(u=>new URL(u).pathname.endsWith('.torrent'));const nyaa=links.find(u=>new URL(u).hostname==='nyaa.si'&&/^\/view\/\d+$/.test(new URL(u).pathname));const dmhy=links.find(u=>new URL(u).hostname.endsWith('dmhy.org')&&new URL(u).pathname.startsWith('/topics/view/'));if(torrent)item.torrentUrl=torrent;else if(nyaa)item.torrentUrl=nyaa.replace('/view/','/download/')+'.torrent';else if(dmhy){const detail=await network.read(dmhy);const page=load(detail.text);const m=page('a[href^="magnet:"]').map((_,e)=>page(e).attr('href')).get().find(v=>magnetHash(v));if(m)item={...item,magnet:m,infoHash:magnetHash(m)};}}
      if(!item.infoHash&&!item.torrentUrl)throw new Error('项目页未提供直接种子，请在统一搜索中查找该作品的发行版本。');
    }
    if(item.torrentUrl){let r;try{r=await network.read(item.torrentUrl,{binary:true,maxBytes:12_000_000});}catch(e){if(!item.infoHash||magnetHash(item.magnet)!==item.infoHash)throw e;item={...item,torrentUrl:''};}if(r){const hash=torrentInfoHash(r.bytes);if(item.infoHash&&item.infoHash!==hash)throw new Error('种子校验与搜索信息不一致，已停止添加。');item={...item,infoHash:hash,torrentData:r.bytes};}}
    if(!item.infoHash||(!item.magnet&&!item.torrentData))throw new Error('没有可直接下载的有效种子。');return item;
  }
  function peek(id){const entry=results.get(id);if(!entry||now()-entry.at>1800000)throw new Error('这条搜索结果已过期，请重新搜索。');return{...entry.item};}
  function reopen(row) {
    const infoHash = String(row.hash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new Error('原记录缺少有效的种子标识。');
    const links = historyLinks(row).flatMap(link => {
      const host = new URL(link.url).hostname;
      const source = publicTorrent(link.url)?.source || (host === 'seadex.moe' ? 'seadex'
        : host === 'nyaa.si' ? 'nyaa' : host.endsWith('dmhy.org') ? 'dmhy'
        : host.endsWith('animes.garden') ? 'garden' : host.endsWith('vcb-s.com') ? 'vcb'
        : host.startsWith('mikan') ? 'mikan' : 'anibt');
      return [{ source, url: link.url }];
    });
    const pageUrl = links.find(link => publicTorrent(link.url))?.url || '';
    const download = pageUrl && publicTorrent(pageUrl);
    const title = row.title || row.animeTitle;
    const metadata = inferRelease(title);
    return remember({
      ...metadata, title, workTitle: row.animeTitle || metadata.workTitle, kind: 'release', infoHash,
      animeTitle: row.animeTitle, bgmId: row.bgmId, episode: row.episode, version: row.version,
      pageUrl, torrentUrl: download?.torrentUrl || '',
      magnet: magnetFor(infoHash, download?.tracker),
      sources: [...new Set(links.map(link => link.source))], links,
    });
  }
  let activeSubtitleBatches = 0;
  async function subtitleDetails(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 12 ||
      ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)))
      throw new Error('请选择至多 12 份当前搜索结果。');
    if (activeSubtitleBatches >= 2) throw new Error('正在核对其他资源的字幕，请稍后再试。');
    const requests = [...new Set(ids)].map(resultId => ({ resultId, url: nyaaSubtitlePage(peek(resultId)) }));
    activeSubtitleBatches++;
    try {
      const details = [];
      for (let offset = 0; offset < requests.length; offset += 3) {
        details.push(...await Promise.all(requests.slice(offset, offset + 3).map(async ({ resultId, url }) => {
          if (!url) return { resultId, state: 'unsupported' };
          try {
            const evidence = await memo('subtitle-page|' + url, async () => {
              const { text } = await network.read(url, { maxBytes: 600000, timeoutMs: 4500 });
              return readNyaaSubtitleDetails(text);
            }, false);
            return { resultId, state: 'checked', ...evidence };
          } catch {
            return { resultId, state: 'unavailable' };
          }
        })));
      }
      return details;
    } finally { activeSubtitleBatches--; }
  }
  return{search,resolve,peek,reopen,subtitleDetails,close:network.close};
}
