import { randomBytes } from 'node:crypto';
import { parseFeed } from './feed.js';
import { createSourceNetwork } from './source-network.js';
export function createAnimeResources(preferences,deps={}){
  const network=deps.network||createSourceNetwork(preferences),cache=new Map(),results=new Map(),now=deps.now||Date.now;
  return{
    async list({bgmId,groupSlug='',episode='',refresh=false}){
      if(!/^\d{1,8}$/.test(bgmId)||Number(bgmId)<1||groupSlug.length>128||groupSlug&&!/^[\w-]+$/.test(groupSlug)||episode&&!/^\d{1,4}$/.test(episode))throw new Error('番剧或发布组、集数无效。');
      const key=[bgmId,groupSlug,episode].join('|');let saved=cache.get(key);
      if(refresh||!saved||now()-saved.at>60000){
        const q=new URLSearchParams({bgmId});if(groupSlug)q.set('groupSlug',groupSlug);if(episode)q.set('episode',episode);
        const r=await network.read('https://anibt.net/rss/anime.xml?'+q);const items=parseFeed(r.text).filter(i=>!i.bgmId||i.bgmId===bgmId).map(i=>({...i,bgmId}));
        saved={at:now(),items};cache.set(key,saved);if(cache.size>30)cache.delete(cache.keys().next().value);
      }
      for(const [id,r]of results)if(now()-r.at>1800000)results.delete(id);
      return{items:saved.items.map(item=>{const resultId=randomBytes(16).toString('hex');results.set(resultId,{at:now(),item});return{...item,resultId};}),limit:100,possiblyLimited:saved.items.length>=100};
    },resolve(id){const row=results.get(id);if(!row||now()-row.at>1800000)throw new Error('资源列表已过期，请刷新并重新选择。');return row.item;}
  };
}
