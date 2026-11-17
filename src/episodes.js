// Read only explicit single-episode labels. Ranges and specials are intentionally unknown.
export function singleEpisode(value){
  const label=String(value??'').normalize('NFKC').trim();
  const match=label.match(/^(?:(?:EP?|#)\s*)?(\d{1,4})(?:v\d+)?$/i)||label.match(/^第\s*(\d{1,4})\s*[集话話]$/)||label.match(/^\[(\d{1,4})(?:v\d+)?\]$/i);
  const n=match?Number(match[1]):0;return n>=1&&n<=9999?n:null;
}
