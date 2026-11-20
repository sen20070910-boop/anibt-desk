import net from 'node:net';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fetch, ProxyAgent } from 'undici';

const hosts=new Set(['api.github.com','r2.anibt.net','anibt.net','www.dmhy.org','share.dmhy.org','dmhy.org','nyaa.si','vcb-s.com','www.vcb-s.com','api.animes.garden','animes.garden','www.animes.garden','mikanime.tv','mikanani.me']);
export function sourceUrl(value,base) {
  let u;try{u=new URL(value,base);}catch{throw new Error('资源链接无效。');}
  if(!['http:','https:'].includes(u.protocol)||!hosts.has(u.hostname)||u.username||u.password||u.port)throw new Error('不支持这个资源站点或地址。');
  u.protocol='https:';u.hash='';return u.href;
}
export function validateProxy(value) {
  let u;try{u=new URL(value);}catch{throw new Error('代理地址无效，例如 http://127.0.0.1:7890。');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('请使用不带账号密码的 HTTP 代理地址。');
  return u.origin;
}
function latestReleaseUrl(value) {
  const u = new URL(value);
  if (u.origin !== 'https://github.com' || u.username || u.password ||
      u.search || u.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/latest$/.test(u.pathname))
    throw new Error('GitHub 更新页面地址无效。');
  return u.href;
}
function releaseAssetUrl(value, base) {
  const url = new URL(value, base);
  const project = /^\/sen20070910-boop\/anibt-desk\/releases\/download\/v(\d+\.\d+\.\d+)\/AniBT-qB-v\1-Windows-x64\.zip(?:\.sha256)?$/;
  const official = url.hostname === 'github.com' && !url.search && project.test(url.pathname);
  const storage = base && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(official || storage))
    throw new Error('GitHub 更新文件地址不符。');
  return url.href;
}
export function createSourceNetwork(getPreferences) {
  const agents=new Map();let proxyProbe=null,proxyState={at:0,available:false};
  const detectProxy=async()=>{if(Date.now()-proxyState.at<30000)return proxyState.available;if(proxyProbe)return proxyProbe;proxyProbe=new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:7890});const end=available=>{socket.destroy();proxyState={at:Date.now(),available};resolve(available);};socket.setTimeout(500,()=>end(false));socket.once('connect',()=>end(true));socket.once('error',()=>end(false));}).finally(()=>proxyProbe=null);return proxyProbe;};
  const cacheKey=()=>{const p=getPreferences();return(p.networkMode||'auto')+'|'+(p.proxyUrl||'http://127.0.0.1:7890');};
  async function read(value,{binary=false,maxBytes=8_000_000,timeoutMs=15000,releaseRedirect=false,releaseAsset=false,destination}={}) {
    const url=releaseAsset?releaseAssetUrl(value):releaseRedirect?latestReleaseUrl(value):sourceUrl(value);const prefs=getPreferences();const mode=prefs.networkMode||'auto';const proxy=mode==='custom'?validateProxy(prefs.proxyUrl):await detectProxy()?'http://127.0.0.1:7890':'';
    const proxyFirst=releaseAsset||releaseRedirect||['api.github.com','r2.anibt.net','dmhy.org','www.dmhy.org','share.dmhy.org','nyaa.si','vcb-s.com','www.vcb-s.com'].includes(new URL(url).hostname);
    const routes=mode==='direct'?['']:mode==='custom'?[proxy]:proxy?(proxyFirst?[proxy,'']:['',proxy]):[''];
    let last;
    for(const route of routes){try{
      let target=url;
      for(let redirects=0;redirects<4;redirects++){
        let dispatcher;if(route){if(!agents.has(route))agents.set(route,new ProxyAgent(route));dispatcher=agents.get(route);}
        const r=await fetch(target,{...(dispatcher?{dispatcher}:{}),...(releaseRedirect?{method:'HEAD'}:{}),redirect:'manual',headers:{'User-Agent':'AniBT-qB/1.3 (+local personal resource search)','Accept':binary?'application/x-bittorrent, application/octet-stream':'application/rss+xml, application/xml, text/html, application/json;q=0.9','Accept-Language':'zh-CN,zh;q=0.9,en;q=0.7'},signal:AbortSignal.timeout(timeoutMs)});
        if(releaseRedirect){
          const location=r.headers.get('location');
          if([301,302,303,307,308].includes(r.status)&&location)return {location};
          throw new Error(`站点未返回最新发布页（HTTP ${r.status}）。`);
        }
        if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();target=(releaseAsset?releaseAssetUrl:sourceUrl)(r.headers.get('location'),target);continue;}
        if (releaseAsset && !r.ok) { await r.body?.cancel(); throw new Error(`站点返回 HTTP ${r.status}。`); }
        if (releaseAsset && destination) {
          let size = 0;
          try {
            await pipeline(r.body, async function* (stream) {
              for await (const chunk of stream) {
                size += chunk.length;
                if (size > maxBytes) throw new Error('站点返回的更新包超出大小限制。');
                yield chunk;
              }
            }, createWriteStream(destination, { flags: 'wx' }));
          } catch (error) {
            await unlink(destination).catch(()=>{});
            throw error;
          }
          return { size };
        }
        const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes){await r.body.cancel().catch(()=>{});throw new Error('站点返回内容过大，请缩小搜索范围。');}chunks.push(Buffer.from(chunk));}
        const bytes=Buffer.concat(chunks);const text=binary?'':bytes.toString('utf8');
        if(/<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(text)){throw Object.assign(new Error('站点要求浏览器验证。'),{code:'BROWSER_REQUIRED'});}
        if(!r.ok)throw new Error(`站点返回 HTTP ${r.status}。`);
        return{bytes,text,url:target,via:route?(mode==='auto'?'FlClash':'自定义代理'):'直连'};
      }
      throw new Error('站点重定向次数过多。');
    }catch(e){last=e;if(e.code==='BROWSER_REQUIRED')throw e;}}
    throw new Error(last?.message?.startsWith('站点')?last.message:'连接超时或失败，请检查 FlClash 和网络。');
  }
  return{read,cacheKey,close:async()=>Promise.allSettled([...agents.values()].map(a=>a.close()))};
}
