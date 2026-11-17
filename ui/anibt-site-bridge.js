/* Runs only inside the dedicated official AniBT WebView. No cookies or passwords leave that view. */
(()=>{
  if(location.origin!=='https://anibt.net')return;
  const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  async function text(url){const u=new URL(url,location.origin);if(u.origin!==location.origin||!/^\/assets\/[\w.$-]+\.js$/.test(u.pathname))throw new Error('不支持的网站资源地址。');const r=await fetch(u,{cache:'no-cache'});if(!r.ok)throw new Error('AniBT 页面资源暂时不可用。');return r.text();}
  async function session(){const r=await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('无法确认 AniBT 登录状态。');const data=await r.json();return data?.user?.id?{id:String(data.user.id),name:String(data.user.name||'AniBT 用户').slice(0,100)}:null;}
  async function adapters(){
    if(window.__anibtDesktopAdapters)return window.__anibtDesktopAdapters;
    const paths=[...document.querySelectorAll('link[rel="modulepreload"]')].map(n=>n.getAttribute('href'));
    let code,modulePath;for(const p of paths.filter(p=>/\/app-shared-[\w-]+\.js$/.test(p||''))){const candidate=await text(p);if(candidate.includes('`my-subscriptions`')){code=candidate;modulePath=p;break;}}
    if(!code)throw new Error('网站订阅接口已变化，请更新工具后重试。');
    const exports=code.slice(code.lastIndexOf('export{'));const exported=symbol=>{const m=exports.match(new RegExp('(?:[,{])'+escapeRegex(symbol)+' as ([\\w$]+)(?=[,}])'));if(!m)throw new Error('无法确认网站订阅函数。');return m[1];};
    const keyFunction=code.match(/function ([\w$]+)\([^)]*\)\{return\[`my-subscriptions`/);if(!keyFunction)throw new Error('网站订阅清单接口已变化。');
    const enclosingFunction=position=>code.slice(code.lastIndexOf('function ',position),position).match(/^function ([\w$]+)\(/)?.[1];
    const queryIndex=code.indexOf('queryKey:'+keyFunction[1]+'(');const listSymbol=enclosingFunction(queryIndex);
    const membershipBlock=code.slice(code.indexOf('`my-subscribed-anime-ids`'),code.indexOf('`my-subscribed-anime-ids`')+1600);
    const membershipMatch=membershipBlock.match(/queryFn:\(\{signal:[\w$]+\}\)=>([\w$]+)\(\{signal:[\w$]+\}\)/);
    const membershipSymbol=membershipMatch?enclosingFunction(code.indexOf('`my-subscribed-anime-ids`')+membershipMatch.index):null;
    const rssIndex=code.indexOf('`subscription-rss-token`');const rssSymbol=enclosingFunction(rssIndex);
    const indexPath=paths.find(p=>/\/index-[\w-]+\.js$/.test(p||''));if(!indexPath||!listSymbol||!membershipSymbol||!rssSymbol)throw new Error('网站订阅接口暂不兼容，请更新工具。');
    const indexCode=await text(indexPath);const commandsFile=indexCode.match(/assets\/useAnimeSubscriptionCommands-[\w-]+\.js/)?.[0];if(!commandsFile)throw new Error('无法确认网站订阅操作。');
    const commands=await text('/'+commandsFile);const imports=commands.match(/import\{([^}]+)\}from["']\.\/app-shared-[\w-]+\.js["']/)?.[1];if(!imports)throw new Error('网站订阅操作接口已变化。');
    const imported=new Map(imports.split(',').map(part=>{const a=part.trim().split(/\s+as\s+/);return[a[1]||a[0],a[0]];}));
    function commandExport(kind){const symbol=commands.match(new RegExp(kind+':[\\w$]+=>[^;]{0,50}?\\?([\\w$]+)\\([\\w$]+\\)'))?.[1];if(!symbol)throw new Error('无法安全识别网站订阅操作。');const local=commands.match(new RegExp('(?:[,;])'+escapeRegex(symbol)+'=[\\w$]+\\(([\\w$]+)\\)'))?.[1];const name=imported.get(local);if(!name)throw new Error('网站订阅操作尚未确认。');return name;}
    const mod=await import(new URL(modulePath,location.origin).href),names={list:exported(listSymbol),memberships:exported(membershipSymbol),rss:exported(rssSymbol),subscribe:commandExport('upsert'),unsubscribe:commandExport('remove')};
    if(Object.values(names).some(n=>typeof mod[n]!=='function'))throw new Error('网站订阅接口暂不可用。');
    return window.__anibtDesktopAdapters={mod,names};
  }
  async function members(adapter,user){const result=await adapter.mod[adapter.names.memberships](user.id).queryFn({signal:new AbortController().signal});if(result?.userId!==user.id||!result.subscriptions||typeof result.subscriptions!=='object')throw new Error('账号状态已变化，请重新连接。');return result.subscriptions;}
  function animeCover(raw){const variants=Array.isArray(raw?.coverImageWebp?.variants)?raw.coverImageWebp.variants:[];const candidates=[...variants.filter(v=>v.width>=360&&v.width<=720).sort((a,b)=>a.width-b.width).map(v=>v.url),raw?.coverImage?.large,raw?.coverImage?.extraLarge,raw?.cover];for(const value of candidates){try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='r2.anibt.net'&&!u.username&&!u.password&&!u.port)return u.href;}catch{}}return '';}
  const titleOf=anime=>String((typeof anime?.title==='string'?anime.title:'')||anime?.title?.chinese||anime?.title?.primary||anime?.titleChinese||anime?.titleRomaji||anime?.title?.native||anime?.title?.romaji||anime?.title?.english||'未命名番剧').slice(0,300);
  async function execute(action,data={}){
    const user=await session();if(action==='session')return{loggedIn:!!user,user};if(!user)throw new Error('请先在官方登录窗口完成 AniBT 登录。');
    if(data.expectedUserId&&data.expectedUserId!==user.id)throw new Error('当前登录账号已变化，请重新连接。');
    const adapter=await adapters();
    if(action==='identity'){
      const value=await adapter.mod[adapter.names.rss](user.id).queryFn({signal:new AbortController().signal});if(value?.userId!==user.id||typeof value.token!=='string'||!value.token)throw new Error('无法确认该账号的私人 RSS，请先在 AniBT 我的订阅中生成链接。');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.token));return{user,keyHash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')};
    }
    if(action==='memberships'){const map=await members(adapter,user);return{user,animeIds:Object.keys(map).filter(safeId)};}
    if(action==='list'){
      const page=Math.max(1,Math.min(10000,Number(data.page)||1));const result=await adapter.mod[adapter.names.list](user.id,page,30).queryFn({signal:new AbortController().signal});
      if(result?.userId!==user.id||!Array.isArray(result.page))throw new Error('网站订阅列表暂时无法读取。');
      return{user,page,total:Number(result.totalCount)||0,totalPages:Number(result.totalPages)||0,hasNext:!!result.hasNextPage,items:result.page.map(row=>({id:String(row.subscription?.animeId||''),cover:animeCover(row.anime),episodes:Number.isInteger(row.anime?.episodes)&&row.anime.episodes>0&&row.anime.episodes<=9999?row.anime.episodes:null,episodesChecked:Object.prototype.hasOwnProperty.call(row.anime||{},'episodes'),averageScore:typeof row.anime?.averageScore==='number'&&Number.isFinite(row.anime.averageScore)&&row.anime.averageScore>0&&row.anime.averageScore<=100?row.anime.averageScore:null,scoreChecked:Object.prototype.hasOwnProperty.call(row.anime||{},'averageScore'),bgmId:row.anime?.bgmId?String(row.anime.bgmId):'',title:titleOf(row.anime),originalTitle:String(row.anime?.title?.native||''),subscribed:true})).filter(row=>safeId(row.id))};
    }
    if(!['subscribe','unsubscribe'].includes(action)||!safeId(data.animeId)||!safeId(data.expectedUserId))throw new Error('订阅操作无效。');
    let map=await members(adapter,user);const before=Object.prototype.hasOwnProperty.call(map,data.animeId),desired=action==='subscribe';
    if(before!==desired){
      const payload={animeId:data.animeId,commandIdentity:String(data.commandIdentity||'')};if(!/^subscription:[a-zA-Z0-9-]{16,80}$/.test(payload.commandIdentity))throw new Error('订阅操作标识无效。');
      if(desired)payload.filters={}; // Existing website filters are never replaced by a duplicate subscribe.
      await adapter.mod[adapter.names[action]]({data:payload});
    }
    const afterUser=await session();if(afterUser?.id!==user.id)throw new Error('操作期间账号发生变化，请重新核对网站状态。');
    map=await members(adapter,user);if(Object.prototype.hasOwnProperty.call(map,data.animeId)!==desired)throw new Error('尚未从网站确认订阅结果，请刷新后核对。');
    return{verified:true,user,animeId:data.animeId,subscribed:desired,existing:before===desired};
  }
  window.__anibtDesktopCall=async(id,action,data)=>{try{const result=await execute(action,data);window.chrome.webview.postMessage({type:'anibt-account-result',id,result});}catch(error){window.chrome.webview.postMessage({type:'anibt-account-result',id,error:String(error?.data?.message||error?.message||'AniBT 账号操作失败，请重新登录并重试。').slice(0,500)});}};
})();
