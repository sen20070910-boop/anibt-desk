import {readLimited} from './response-body.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { singleEpisode } from './episodes.js';
import {episodeIdentity} from './anime-identity.js';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, processEntities: true });
const list = x => x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
const str = x => typeof x === 'object' && x ? String(x['#text'] ?? '') : String(x ?? '');
const releasePage=value=>{try{const u=new URL(str(value));return u.protocol==='https:'&&u.hostname==='anibt.net'&&!u.username&&!u.password&&u.pathname.startsWith('/release/')?u.origin+u.pathname:'';}catch{return '';}};
const values = x => list(x).map(str).filter(Boolean);
export const norm = x => String(x ?? '').normalize('NFKC').toLowerCase().trim();
const plain = x => String(x || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
function legacyMetadata(raw, title) {
  // Personal subscriptions currently use the older RSS schema, unlike the public feed.
  // Its generated description has the same structured heading/footer as release pages.
  const desc = str(raw.description);
  const header = desc.match(/<p>\s*<strong>([\s\S]*?)<\/strong>\s*·\s*([^<·]+)\s*·\s*(v\d+)[\s\S]*?<\/p>/i);
  const footer = desc.match(/<p>\s*🏷️([\s\S]*?)<\/p>/)?.[1] || '';
  const tag = emoji => plain(footer.match(new RegExp(`${emoji}\\s*([^·<]+)`))?.[1]);
  const lang = tag('🌐');
  const languages = lang ? lang.split('+').map(s=>s.trim()) : [
    /简|簡|\bCHS\b|\bGB\b/i.test(title) ? 'CHS' : '', /繁|\bCHT\b|\bBIG5\b/i.test(title) ? 'CHT' : '',
  ].filter(Boolean);
  const name = plain(header?.[1]).split(' / ')[0] || title.replace(/^[\[【][^\]】]+[\]】]\s*/, '').split(/\s+\/\s+|\s+-\s+\d|\s*\[\d/)[0].trim();
  return { animeTitle: name, bgmId: desc.match(/https?:\/\/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/)?.[1] || '',
    episode: plain(header?.[2]) || title.match(/\[(\d+(?:-\d+)?)\]/)?.[1] || '', version: header?.[3] || 'v1',
    groupName: plain(footer.split('·')[0]),
    resolution: tag('📺') || title.match(/\b(2160p|1080p|720p|480p|4K)\b/i)?.[1] || '',
    languages, subtitles: tag('💬') ? [tag('💬')] : /内封|內封/.test(title) ? ['INTERNAL'] : /内嵌|內嵌/.test(title) ? ['EMBEDDED'] : [],
  };
}
function torrentURL(raw) {
  if (!raw) return '';
  try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'anibt.net' && /^\/api\/torrent\/[^/]+\.torrent$/.test(u.pathname) ? u.href : ''; }
  catch { return ''; }
}
export function parseFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS 包含不支持的 XML 声明。');
  if (XMLValidator.validate(xml) !== true) throw new Error('RSS 不是有效 XML。');
  const d = parser.parse(xml);
  const ch = d?.rss?.channel;
  if (!ch || typeof ch !== 'object') throw new Error('服务器没有返回 RSS；请检查私人订阅链接是否有效。');
  const items = list(ch.item).map(raw => {
    const title = str(raw.title);
    const legacy = legacyMetadata(raw, title);
    const magnet = [str(raw['anibt:magnet']), str(raw.link), ...list(raw.enclosure).map(x=>str(x?.['@_url']))].find(x=>x.startsWith('magnet:?')) || '';
    const torrentUrl = [str(raw['anibt:torrentUrl']), ...list(raw.enclosure).map(x=>str(x?.['@_url']))].map(torrentURL).find(Boolean) || '';
    const hash = str(raw.torrent?.infohash || raw['anibt:infoHash']).toLowerCase();
    const magnetHash = magnet ? new URL(magnet).searchParams.getAll('xt').map(x=>x.match(/^urn:btih:([a-f0-9]{40})$/i)?.[1]).find(Boolean) : '';
    const infoHash = /^[a-f0-9]{40}$/.test(hash) ? hash : (magnetHash || '').toLowerCase();
    const id = str(raw['anibt:releaseId'] || raw.guid) || infoHash || createHash('sha256').update(title + torrentUrl + magnet).digest('hex');
    const bgmId = str(raw['anibt:bgmId']) || legacy.bgmId;
    const episode = str(raw['anibt:episodeKey'] || raw['anibt:episode']) || legacy.episode;
    const version = str(raw['anibt:version']) || legacy.version;
    const animeTitle = str(raw['anibt:animeTitle']) || legacy.animeTitle;
    return { id, title, animeTitle, bgmId, episode, version,
      groupName: str(raw['anibt:groupName']) || legacy.groupName || title.match(/^[\[【]([^\]】]+)[\]】]/)?.[1] || '', groupSlug: str(raw['anibt:groupSlug']),
      resolution: str(raw['anibt:resolution']) || legacy.resolution, languages: raw['anibt:language'] ? values(raw['anibt:language']) : legacy.languages, subtitles: raw['anibt:subtitle'] ? values(raw['anibt:subtitle']) : legacy.subtitles,
      releaseUrl:releasePage(raw.link),publishedAt: str(raw.pubDate), infoHash, torrentUrl, magnet,
      episodeKey: animeTitle && episode && !/^(batch|合集|全集)$/i.test(episode) ? `${norm(animeTitle)}:${/^\d+$/.test(episode) ? Number(episode) : episode}:${version}` : '',
    };
  });
  // Old subscriptions may omit bgmId in some entries. Share an unambiguous ID
  // only between entries with the same generated anime title in this response.
  const idsByTitle = new Map();
  for (const item of items) if (item.bgmId && item.animeTitle) {
    const name=norm(item.animeTitle);
    if (!idsByTitle.has(name)) idsByTitle.set(name,new Set());
    idsByTitle.get(name).add(item.bgmId);
  }
  for (const item of items) if (!item.bgmId && idsByTitle.get(norm(item.animeTitle))?.size === 1)
    item.bgmId = [...idsByTitle.get(norm(item.animeTitle))][0];
  return items.map(item=>({...item,episodeKey:episodeIdentity(item)}));
}
export function matchingAnimeRule(item,config){return config.rules.find(r=>r.bgmId?String(r.bgmId)===String(item.bgmId):norm(item.animeTitle||item.title).includes(norm(r.title)));}
export function beijingDate(value){const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()+8*3600000).toISOString().slice(0,10):'';}
export function effectiveFilters(item, config) {
  // First matching per-anime rule overrides only explicitly provided fields.
  const rule = matchingAnimeRule(item,config);
  return { ...config.filters,startDate:config.startDate||'',startEpisode:config.startEpisode??'', ...rule };
}
export function matches(item, config,now=new Date()) {
  const f = effectiveFilters(item, config);
  if (f.enabled === false) return { ok: false, reason: '番剧规则已禁用' };
  if(f.startEpisode!==''){
    const episode=singleEpisode(item.episode);
    if(episode===null)return{ok:false,reason:'无法确认单集编号（合集、特别篇或未知集号），按集数追番时跳过'};
    if(episode<f.startEpisode)return{ok:false,reason:`早于开始追番集数（从第 ${f.startEpisode} 集起）`};
  }
  if(f.startDate){
    if(f.startDate>beijingDate(now))return{ok:false,reason:'尚未到开始追番日期'};
    const published=beijingDate(item.publishedAt);
    if(!published)return{ok:false,reason:'发布时间未知，无法核对开始日期'};
    if(published<f.startDate)return{ok:false,reason:'早于开始追番日期'};
  }
  if (f.groups?.length) {
    const names = [item.groupName, item.groupSlug, ...(item.title.match(/^[\[【]([^\]】]+)[\]】]/)?.[1] || '').split(/[&＆+、]/)].map(norm).filter(Boolean);
    if (!f.groups.some(g => names.includes(norm(g)))) return { ok: false, reason: '压制组不匹配' };
  }
  if (f.resolutions?.length && !f.resolutions.map(norm).includes(norm(item.resolution))) return { ok: false, reason: '画质不匹配' };
  if (f.languages?.length && !f.languages.some(l => item.languages.map(norm).includes(norm(l)))) return { ok: false, reason: '字幕语言不匹配' };
  if (f.subtitles?.length && !f.subtitles.some(l => item.subtitles.map(norm).includes(norm(l)))) return { ok: false, reason: '字幕形式不匹配' };
  if (f.include?.length && !f.include.every(s=>norm(item.title).includes(norm(s)))) return { ok: false, reason: '缺少包含关键词' };
  if (f.exclude?.some(s=>norm(item.title).includes(norm(s)))) return { ok: false, reason: '命中排除关键词' };
  if (!item.infoHash && !item.torrentUrl && !item.magnet) return { ok: false, reason: '没有有效种子地址或磁力' };
  return { ok: true, reason: '符合规则' };
}
export function sourceKey(url) { return createHash('sha256').update(url).digest('hex'); }
export async function fetchFeed(url) {
  const r = await safeFetch(url, { headers: { 'User-Agent': 'AniBT-qB/1.0', Accept: 'application/rss+xml, application/xml, text/xml' } });
  const xml = (await readLimited(r,{label:'RSS'})).toString('utf8');
  if (xml.length > 20_000_000) throw new Error('RSS 响应过大。');
  const items = parseFeed(xml);
  if (items.some(i=>!i.groupSlug)) {
    try {
      if (!groupCache || Date.now()-groupCache.at > 60000) {
        const result = await (await safeFetch('https://anibt.net/api/subtitle-groups')).json();
        if (Array.isArray(result.data)) groupCache = { at: Date.now(), groups: result.data };
      }
      for (const item of items) if (!item.groupSlug) item.groupSlug = groupCache?.groups.find(g=>norm(g.name)===norm(item.groupName))?.slug || '';
    } catch {} // A group directory outage must not block name-based subscriptions.
  }
  return items;
}
let groupCache;
export async function safeFetch(url, options = {}) {
  let r;
  try { r = await fetch(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw new Error('网络连接失败或超时，请检查地址、网络及代理设置。'); }
  if (!r.ok) {
    const error = new Error(`请求失败（HTTP ${r.status}）${r.status === 401 ? '：RSS 令牌无效或需要登录' : r.status === 403 ? '：访问被拒绝，请检查 Web UI 身份验证' : r.status === 429 ? '：请求过于频繁，稍后重试' : ''}。`);
    error.httpStatus=r.status;await r.body?.cancel().catch(()=>{});
    const retry = r.headers.get('retry-after');
    const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
    if (Number.isFinite(seconds)&&seconds > 0) error.retryAfterSeconds = seconds;
    throw error;
  }
  return r;
}
