import {randomBytes} from 'node:crypto';
import {createSourceNetwork} from './source-network.js';

function isRatingCover(url) {
  const { hostname, pathname } = url;
  if (url.search) return false;
  if (hostname === 'lain.bgm.tv') return /^(?:\/r\/\d+)?\/pic\/cover\//.test(pathname);
  if (hostname === 'cdn.myanimelist.net') return /^\/images\/anime\//.test(pathname);
  if (hostname === 's4.anilist.co') return /^\/file\/anilistcdn\/media\/anime\/cover\//.test(pathname);
  return /^img[1239]\.doubanio\.com$/.test(hostname) && /^\/view\/photo\/s_ratio_poster\/public\//.test(pathname);
}

export function imageMime(buffer) {
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'image/jpeg';
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(/^GIF8[79]a/.test(buffer.subarray(0,6).toString()))return 'image/gif';
  throw new Error('封面不是支持的图片格式。');
}

export function createArtwork(preferences, deps={}) {
  const network=deps.network||createSourceNetwork(preferences);
  const maxBytes=deps.maxCacheBytes??16_000_000, maxEntries=deps.maxEntries??256;
  const urls=new Map(),images=new Map(),waiting=[];
  let bytes=0,active=0;
  function touch(id,row){images.delete(id);images.set(id,row);}
  function evict(){
    while(images.size>maxEntries){
      const entry=[...images].find(([,row])=>!row.pending);
      if(!entry)break;
      const [id,row]=entry;images.delete(id);urls.delete(row.url);bytes-=row.bytes?.length||0;
    }
  }
  async function slot(callback){
    if(active>=3)await new Promise(resolve=>waiting.push(resolve));
    active++;
    try{return await callback();}
    finally{active--;waiting.shift()?.();}
  }
  return {
    register(value){
      let url;try{url=new URL(value);}catch{throw new Error('封面地址无效。');}
      if(url.protocol!=='https:'||!(url.hostname==='r2.anibt.net'||isRatingCover(url))||url.username||url.password||url.port||url.href.length>1800)throw new Error('仅允许受支持的官方封面图片。');
      url.hash='';
      if(urls.has(url.href)){
        const id=urls.get(url.href);touch(id,images.get(id));return {src:'/covers/'+id};
      }
      const id=randomBytes(16).toString('hex');
      urls.set(url.href,id);images.set(id,{url:url.href});evict();return {src:'/covers/'+id};
    },
    async get(id){
      const row=images.get(id);if(!row)throw new Error('封面缓存已过期。');
      touch(id,row);
      if(row.bytes)return row;
      if(row.pending)return row.pending;
      row.pending=slot(async()=>{
        const response=await network.read(row.url,{binary:true,image:true,maxBytes:4_000_000});
        const buffer=response.bytes,mime=imageMime(buffer);
        // Return valid bytes even when a single image exceeds a custom cache budget.
        if(buffer.length>maxBytes)return {...row,bytes:buffer,mime};
        while(bytes+buffer.length>maxBytes){
          const entry=[...images.values()].find(item=>item.bytes&&item!==row);
          if(!entry)break;
          bytes-=entry.bytes.length;delete entry.bytes;
        }
        if(images.get(id)===row){row.bytes=buffer;row.mime=mime;bytes+=buffer.length;}
        return {...row,bytes:buffer,mime};
      }).finally(()=>{delete row.pending;evict();});
      return row.pending;
    },
    stats(){return {bytes,entries:images.size,active,queued:waiting.length};}
  };
}
