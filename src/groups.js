import { norm } from './feed.js';

export function mergeGroupOptions({ items=[], directory=[], published=[], bgmId='', title='' }={}) {
  const scoped=!!(bgmId||title),groups=[];
  function merge(group,source) {
    const name=String(group.name||group.groupName||group.slug||'').trim();
    const slug=String(group.slug||group.groupSlug||name).trim();if(!name)return;
    const aliases=[norm(name),norm(slug)];
    let entry=groups.find(g=>[norm(g.name),norm(g.slug)].some(a=>aliases.includes(a)));
    if(!entry){entry={name,slug,published:false,subscription:false,totalReleases:0,hasSimplified:false};groups.push(entry);}
    if(source!=='subscription'||!entry.slug||entry.slug===entry.name){entry.name=name;entry.slug=slug;}
    if(source==='published'){entry.published=true;entry.totalReleases=Math.max(entry.totalReleases,Number(group.totalReleases)||0);entry.hasSimplified||=(group.items||[]).some(i=>(i.language||[]).includes('CHS'));}
    if(source==='subscription'){entry.published=true;entry.subscription=true;entry.feedCount=(entry.feedCount||0)+1;entry.hasSimplified||=(group.languages||[]).includes('CHS');}
  }
  if(!scoped)for(const group of directory)merge(group,'directory');
  for(const group of published)merge(group,'published');
  for(const item of items) {
    const relevant=!scoped||(bgmId&&item.bgmId?String(item.bgmId)===String(bgmId):title&&norm(item.animeTitle)===norm(title));
    if(relevant)merge(item,'subscription');
  }
  for(const group of groups)group.totalReleases=Math.max(group.totalReleases,group.feedCount||0);
  return groups.sort((a,b)=>Number(b.subscription)-Number(a.subscription)||Number(b.published)-Number(a.published)||a.name.localeCompare(b.name,'zh-CN'));
}
