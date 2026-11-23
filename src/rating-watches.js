import { normalizedTitle, subjectId } from './anime-identity.js';
import { manualWorkDisplayTitle, releaseWorkAliases } from './release-title.js';

const sources = ['bangumi', 'mal', 'anilist', 'douban'];
const idFor = (source, id) => source === 'bangumi' ? subjectId(id)
  : /^[1-9]\d{0,9}$/.test(String(id ?? '')) ? String(id) : '';
const nameKey = name => normalizedTitle(name).replace(/[^\p{L}\p{N}]+/gu, '');
const hasInstallment = name => /\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|s\d+|part\s*\d+|cour\s*\d+)\b|第\s*[\d一二三四五六七八九十]+\s*(?:[季期部]|クール)/iu.test(name);
const formatOf = format => ({ tv_short: 'tv', tv_special: 'special' })[format] || format;

export function ratingIdentity(input = {}) {
  const ids = Object.fromEntries(sources.flatMap(source => {
    const id = idFor(source, input?.ids?.[source]);
    return id ? [[source, id]] : [];
  }));
  const rawFormat = typeof input?.format === 'string' ? input.format.toLowerCase() : '';
  const format = ['tv','tv_short','movie','special','tv_special','ova','ona'].includes(rawFormat)
    ? formatOf(rawFormat) : '';
  const year = /^(?:19|20|21)\d{2}$/.test(String(input?.year ?? '')) ? String(input.year) : '';
  return { ids, year, format };
}

export function ratingWatchWork(input) {
  if (typeof input?.title !== 'string' || !input.title.trim() || input.title.length > 300 ||
      !Array.isArray(input.names) || input.names.length > 12 ||
      input.names.some(name => typeof name !== 'string' || name.length > 300))
    throw Error('榜单作品信息无效，请刷新重试。');
  const title = input.title.trim();
  const identity = ratingIdentity(input);
  if (!Object.keys(identity.ids).length) throw Error('这部作品缺少可核对的站点编号。');
  const installment = hasInstallment(title);
  const names = [title, ...input.names.filter(name => !installment || hasInstallment(name))];
  return { title, names: new Set(names.map(nameKey).filter(Boolean)), ...identity };
}

export function ratingWatchEvidence(manual, config) {
  const aliases = new Map(), bound = new Map();
  for (const row of Object.values(manual)) {
    if (typeof row.animeTitle !== 'string' || typeof row.title !== 'string') continue;
    const names = releaseWorkAliases(row.title).map(nameKey);
    const name = manualWorkDisplayTitle(row.animeTitle, [row]);
    if (!names.includes(nameKey(name)) || !names.length) continue;
    const key = normalizedTitle(row.animeTitle);
    aliases.set(key, [...new Set([...(aliases.get(key) || []), ...names])]);
  }
  for (const binding of Array.isArray(config.bindings) ? config.bindings : []) {
    const id = subjectId(binding?.bgmId);
    if (!id) continue;
    for (const name of [binding.title, ...(Array.isArray(binding.aliases) ? binding.aliases : [])])
      bound.set(normalizedTitle(name), id);
  }
  return { aliases, bound };
}

export function findRatingWatch(tracking, work, evidence) {
  const byId = [], byName = [];
  const bangumi = work.ids.bangumi;
  if (bangumi && Object.hasOwn(tracking, 'bgm:' + bangumi)) return 'bgm:' + bangumi;
  for (const [key, entry] of Object.entries(tracking)) {
    const identity = ratingIdentity(entry.ratingIdentity);
    const localName = normalizedTitle(entry.title);
    const actualBgm = subjectId(entry.bgmId || (key.startsWith('bgm:') ? key.slice(4) : ''))
      || identity.ids.bangumi || evidence?.bound.get(localName);
    if (bangumi && actualBgm === bangumi) return key;
    if (actualBgm) identity.ids.bangumi = actualBgm;
    const shared = sources.filter(source => work.ids[source] && identity.ids[source]);
    if (shared.some(source => work.ids[source] !== identity.ids[source])) continue;
    if (shared.length) byId.push(key);
    else if ((!work.year || !identity.year || work.year === identity.year) &&
      (!work.format || !identity.format || work.format === identity.format) &&
      (work.names.has(nameKey(entry.title)) ||
        evidence?.aliases.get(localName)?.some(name => work.names.has(name)))) byName.push(key);
  }
  const matches = byId.length ? byId : byName;
  return matches.length === 1 ? matches[0] : '';
}

export const ratingWatchStatus = entry => entry?.completedAt ? {
  watched: true,
  score: entry.personalReview?.score ?? null,
} : null;

export function ratingWatchKey(work, tracking) {
  if (work.ids.bangumi) return 'bgm:' + work.ids.bangumi;
  const titleKey = 'title:' + normalizedTitle(work.title);
  if (!Object.hasOwn(tracking, titleKey)) return titleKey;
  const [source, id] = Object.entries(work.ids)[0];
  return titleKey + ' [' + source + ':' + id + ']';
}
