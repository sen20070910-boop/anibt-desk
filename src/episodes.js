// Read only explicit single-episode labels. Ranges and specials are intentionally unknown.
export function singleEpisode(value){
  const label=String(value??'').normalize('NFKC').trim();
  const match=label.match(/^(?:(?:EP?|#)\s*)?(\d{1,4})(?:v\d+)?$/i)||label.match(/^第\s*(\d{1,4})\s*[集话話]$/)||label.match(/^\[(\d{1,4})(?:v\d+)?\]$/i);
  const n=match?Number(match[1]):0;return n>=1&&n<=9999?n:null;
}

export function episodeInReleaseTitle(value) {
  const title = String(value ?? '').normalize('NFKC').replace(/^\[[^\]]+\]\s*/, '');
  if (/(?:合集|全集|\bbatch\b)|(?:\bE|\[|\s-\s)\d{1,4}\s*(?:-|~|～|至)\s*(?:E|EP)?\d{1,4}\b/i.test(title))
    return null;
  const match = title.match(/\bS\d{1,2}E(\d{1,4})(?:v\d+)?\b/i)
    || title.match(/第\s*(\d{1,4})\s*[集话話]/)
    || title.match(/\s+-\s+(\d{1,4})(?:v\d+)?(?=\s|\[|\(|$)/i)
    || title.match(/\[(\d{1,4})(?:v\d+)?\]/i);
  if (!match || (match[1].length === 4 && /^(?:19|20)\d\d$/.test(match[1]))) return null;
  return singleEpisode(match[1]);
}
