import { currentSeason, normalizeSeason } from './anibt-catalog.js';
import { matches } from './feed.js';
import { singleEpisode } from './episodes.js';
import { groupPriority } from './priority.js';
import { explicitEpisodeWatched } from './progress.js';

export function catchupTiming(anime, now=new Date()) {
  const current=currentSeason(now);let season='';
  try { season=normalizeSeason(`${anime.year}${anime.season}`); } catch {}
  const ordinal=s=>Number(s.slice(0,4))*4+'冬春夏秋'.indexOf(s[4]);
  const older=!!season&&ordinal(season)<ordinal(current);
  const finished=anime.status==='FINISHED';
  return {season,currentSeason:current,older,finished,offer:older||finished};
}

export function resourceDownloadConfig(config,mode='normal'){
  if(mode==='normal')return config;
  const override=mode==='completed'?{startDate:'',startEpisode:''}:{startDate:''};
  return {...config,...override,rules:config.rules.map(rule=>({...rule,...override}))};
}

// Recommendations use the same date/episode policy as preview and submission.
export function catchupRecommendations(items,config,tracking,handled=()=>false,mode='catchup') {
  const preview=resourceDownloadConfig(config,mode);
  const rank=i=>groupPriority(i,config).rank;
  const selected=[],episodes=new Set(items.filter(handled).map(i=>singleEpisode(i.episode)).filter(i=>i!==null));
  for(const item of [...items].sort((a,b)=>rank(a)-rank(b)||String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')))) {
    const episode=singleEpisode(item.episode);
    if(episode===null||episodes.has(episode)||handled(item)||explicitEpisodeWatched(item,tracking,config)||!matches(item,preview).ok||!/^[a-f0-9]{40}$/i.test(item.infoHash||''))continue;
    episodes.add(episode);selected.push(item.resultId);if(selected.length===50)break;
  }
  return selected;
}
