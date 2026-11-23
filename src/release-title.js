import { normalizedTitle } from './anime-identity.js';

const technicalTag = /^(?:\d{1,2}[ -]?bit|(?:2160|1080|720|480)[pi]|(?:1920|1280)[x×](?:1080|720)|4K|BD(?:Rip|Remux)?|Blu[ -]?Ray|UHD|WEB(?:[ -]?(?:DL|Rip))?|DVD(?:Rip)?|HEVC|AVC|AV1|[xh][ .]?26[45]|Dual[ -]?Audio|Multi(?:ple)?[ -]?Subs?|[A-F0-9]{8}|Fin|END|Reseed|CHS|CHT)(?![\p{L}\p{N}])/iu;
const releaseName = title => title.replace(/^[\[【][^\]】]+[\]】]\s*/, '').trim();

export function releaseWorkTitle(title) {
  const name = releaseName(title).replace(/\.(?:mkv|mp4|avi|mov|m2ts|ts|webm|torrent)$/i, '').trim();
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

export function manualWorkDisplayTitle(title, resources) {
  const legacy = normalizedTitle(title);
  const unfinished = /[\[(]([^\[\]()]+)$/.exec(legacy) || /【([^【】]+)$/.exec(legacy);
  if (!unfinished || !technicalTag.test(unfinished[1].trim())) return title;

  // Use the release only if it confirms the saved name is a truncated prefix.
  // The corrected name is for display, since the saved name can also be a key.
  for (const resource of resources) {
    const original = resource.title || '';
    const name = normalizedTitle(releaseName(original));
    if (name.length <= legacy.length || !name.startsWith(legacy)) continue;
    const parsed = releaseWorkTitle(original).split(/\s+\/\s+/)[0].trim();
    if (parsed && legacy.startsWith(normalizedTitle(parsed)) && parsed.length < title.length) return parsed;
  }
  return title;
}
