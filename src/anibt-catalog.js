import { createSourceNetwork } from './source-network.js';
const weekdays=[1,2,3,4,5,6,0,null];
const labels=['周日','周一','周二','周三','周四','周五','周六'];
export function currentSeason(now=new Date()){
  const beijing=new Date(now.getTime()+8*3600000);
  return `${beijing.getUTCFullYear()}${['冬','春','夏','秋'][Math.floor(beijing.getUTCMonth()/3)]}`;
}
export function normalizeSeason(value){
  const match=String(value).trim().match(/^(20\d{2}|21\d{2})[-\s]?(冬|春|夏|秋|WINTER|SPRING|SUMMER|FALL)$/i);
  if(!match)throw new Error('季度格式无效，请选择年份和季度。');
  const quarter={WINTER:'冬',SPRING:'春',SUMMER:'夏',FALL:'秋'};
  return match[1]+(quarter[match[2].toUpperCase()]||match[2]);
}
export function seasonCatalog(payload,requested){
  const data=payload?.ok===true&&payload.data;
  if(!data||!Array.isArray(data.byWeekday)||data.scope?.kind!=='season')throw new Error('AniBT 季度接口已变化，请更新工具。');
  if(normalizeSeason(data.requestedSeason)!==requested)throw new Error('AniBT 返回的季度与选择不一致，请重试。');
  const groups=weekdays.map(weekday=>({weekday,label:weekday===null?'未排播':labels[weekday],items:[]})),seen=new Set();
  for(const group of data.byWeekday){
    if(!Array.isArray(group.animes))throw new Error('AniBT 季度数据暂时无法读取。');
    for(const raw of group.animes){
      const item=catalogAnime({...raw,_id:raw.animeId});if(!item||seen.has(item.id))continue;seen.add(item.id);
      const day=Object.hasOwn(raw,'weekday')?raw.weekday:group.weekday;
      const weekday=Number.isInteger(day)&&day>=0&&day<=6?day:null;
      const stamp=raw.scheduleStatus==='scheduled'&&Number.isFinite(raw.airingAt)&&raw.airingAt>=946684800&&raw.airingAt<7258118400?raw.airingAt:null;
      const clock=stamp===null?null:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(stamp*1000));
      const cover=animeCover(raw);
      Object.assign(item,{weekday,airTime:weekday===null?null:clock,scheduleStatus:weekday===null?'missing_source':clock?'scheduled':'weekday_only',cover,hasRelease:raw.hasRelease===true});
      groups.find(g=>g.weekday===weekday).items.push(item);
    }
  }
  for(const g of groups)g.items.sort((a,b)=>(a.airTime||'99:99').localeCompare(b.airTime||'99:99')||a.title.localeCompare(b.title,'zh-CN'));
  const available=[...new Set([requested,currentSeason(),...(data.availableSeasons||[]).flatMap(s=>{try{return[normalizeSeason(s)];}catch{return[];}})])];
  available.sort((a,b)=>Number(a.slice(0,4))-Number(b.slice(0,4))||'冬春夏秋'.indexOf(a[4])-'冬春夏秋'.indexOf(b[4]));
  return{season:requested,currentSeason:currentSeason(),availableSeasons:available,groups,total:seen.size,truncated:data.truncated===true,limit:Number(data.limit)||200,timeZone:'Asia/Shanghai'};
}
export function animeCover(raw){const variants=Array.isArray(raw?.coverImageWebp?.variants)?raw.coverImageWebp.variants:[];const candidates=[...variants.filter(v=>v.width>=360&&v.width<=720).sort((a,b)=>a.width-b.width).map(v=>v.url),raw?.coverImage?.large,raw?.coverImage?.extraLarge,raw?.cover];for(const value of candidates){try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='r2.anibt.net'&&!u.username&&!u.password&&!u.port)return u.href;}catch{}}return '';}
export function animeScore(value){return typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=100?value:null;}
export function animeEpisodes(value){return Number.isInteger(value)&&value>0&&value<=9999?value:null;}
export function catalogAnime(raw){
  const id=String(raw?._id||raw?.id||'');if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))return null;
  const titles=raw.title||{};const title=String(titles.chinese||raw.titleChinese||titles.primary||titles.native||titles.japanese||titles.romaji||raw.titleRomaji||titles.english||'未命名番剧').slice(0,300);
  return{id,averageScore:animeScore(raw.averageScore),scoreChecked:Object.hasOwn(raw,'averageScore'),cover:animeCover(raw),bgmId:Number.isInteger(raw.bgmId)&&raw.bgmId>0?String(raw.bgmId):'',title,originalTitle:String(titles.native||titles.japanese||titles.english||raw.titleRomaji||'').slice(0,300),format:String(raw.format||''),status:['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS'].includes(raw.status)?raw.status:'',season:String(raw.season||''),year:Number(raw.seasonYear)||null,episodes:animeEpisodes(raw.episodes),episodesChecked:Object.hasOwn(raw,'episodes'),pageUrl:'https://anibt.net/anime/'+(raw.bgmId||id)};
}
export function createAnimeCatalog(preferences,deps={}){
  const network=deps.network||createSourceNetwork(preferences);const cache=new Map(),coverCache=new Map();
  return{async covers({items,refresh=false}){if(!Array.isArray(items)||items.length>60||items.some(i=>!i||typeof i.title!=='string'||i.title.length>300||typeof i.bgmId!=='string'||i.bgmId&&!/^\d{1,8}$/.test(i.bgmId)))throw new Error('封面查询条件无效。');const result=[],queue=[...items];const keyOf=i=>i.bgmId?'bgm:'+i.bgmId:'title:'+i.title.normalize('NFKC').trim().toLowerCase();const search=this.search.bind(this);await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){const i=queue.shift(),key=keyOf(i),old=coverCache.get(key);if(!refresh&&old&&Date.now()-old.at<3600000){result.push({key,cover:old.cover,averageScore:old.averageScore,episodes:old.episodes??null,scoreChecked:true});continue;}let cover='',averageScore=null,episodes=null;try{const found=await search({query:i.title.slice(0,100),refresh}),match=found.items.find(row=>i.bgmId?row.bgmId===i.bgmId:row.title.normalize('NFKC').trim().toLowerCase()===i.title.normalize('NFKC').trim().toLowerCase());cover=match?.cover||'';averageScore=match?.averageScore??null;episodes=match?.episodes??null;}catch{}coverCache.set(key,{at:Date.now(),cover,averageScore,episodes});if(coverCache.size>600)coverCache.delete(coverCache.keys().next().value);result.push({key,cover,averageScore,episodes,scoreChecked:true});}}));return{items:result};},async season({season=currentSeason(),refresh=false}={}){
    season=normalizeSeason(season);const key='season:'+season;
    if(!refresh&&cache.has(key)&&Date.now()-cache.get(key).at<300000)return cache.get(key).data;
    const response=await network.read('https://anibt.net/api/seasons/anime?'+new URLSearchParams({season}));let payload;
    try{payload=JSON.parse(typeof response==='string'?response:response.text);}catch{throw new Error('AniBT 季度数据暂时无法读取，请稍后重试。');}
    const result=seasonCatalog(payload,season);cache.set(key,{at:Date.now(),data:result});if(cache.size>30)cache.delete(cache.keys().next().value);return result;
  },async search({query='',cursor='',refresh=false}={}){
    query=String(query).trim();cursor=String(cursor);if(query.length>100||cursor.length>3000)throw new Error('搜索条件过长，请缩短关键词。');
    const key=JSON.stringify([query,cursor]);if(!refresh&&cache.has(key)&&Date.now()-cache.get(key).at<60000)return cache.get(key).data;
    const q=new URLSearchParams({limit:'24'});if(query)q.set('q',query);if(cursor)q.set('cursor',cursor);
    const r=await network.read('https://anibt.net/api/animes/search?'+q);let data;try{data=JSON.parse(typeof r==='string'?r:r.text);}catch{throw new Error('AniBT 番剧搜索暂时无法读取。');}
    if(!Array.isArray(data.page))throw new Error('AniBT 番剧搜索接口已变化，请更新工具。');
    const result={items:data.page.map(catalogAnime).filter(Boolean),cursor:data.isDone?'':String(data.continueCursor||''),done:!!data.isDone};cache.set(key,{at:Date.now(),data:result});if(cache.size>30)cache.delete(cache.keys().next().value);return result;
  }};
}
