import {readLimited} from './response-body.js';
import { safeFetch,matchingAnimeRule } from './feed.js';
import { getPassword,validateDownloadPath } from './config.js';
import { torrentInfoHash } from './torrent.js';
import { ensureQbRunning } from './qb-launch.js';
import { animeDownloadPath } from './download-path.js';

export const sleep = ms => new Promise(resolve=>setTimeout(resolve, ms));
export class QbClient {
  constructor(config) { this.config = config; this.base = config.qb.url.replace(/\/$/, ''); this.cookie = ''; }
  async connectForDownload(){await ensureQbRunning(this.config);return this.login();}
  async request(method, body, query = '') {
    const headers = { Referer: this.base + '/', Origin: new URL(this.base).origin };
    if (this.cookie) headers.Cookie = this.cookie;
    return safeFetch(`${this.base}/api/v2/${method}${query}`, { headers, ...(body ? { method: 'POST', body } : {}) });
  }
  async login() {
    const password = getPassword(this.config);
    const r = await this.request('auth/login', new URLSearchParams({ username: this.config.qb.username, password }));
    const responseText = (await r.text()).trim();
    if (responseText !== 'Ok.' && r.status !== 204) throw Object.assign(new Error('qBittorrent 登录失败，请检查用户名和密码。'),{code:'AUTH_FAILED'});
    this.cookie = r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
    if (!this.cookie) throw new Error('qBittorrent 没有返回登录会话。');
    this.version = (await (await this.request('app/version')).text()).trim();
    return this.version;
  }
  async list() { return (await this.request('torrents/info')).json(); }
  async has(hash) { return (await (await this.request('torrents/info', null, '?hashes=' + encodeURIComponent(hash))).json()).some(x=>x.hash.toLowerCase() === hash.toLowerCase()); }
  async ensureCategory() {
    const name = this.config.qb.category;
    if (!name) return;
    const cats = await (await this.request('torrents/categories')).json();
    if (!Object.hasOwn(cats, name)) {
      const body = new URLSearchParams({ category: name });
      // A configured per-torrent save path is sent when adding, leaving category defaults intact.
      await this.request('torrents/createCategory', body);
    }
  }
  async add(item, { stopped = this.config.qb.paused,savePath=this.config.qb.savePath,organizeByAnime=false,onSubmitting } = {}) {
    if (!item.infoHash) throw Object.assign(new Error('条目缺少 infohash，无法确认添加成功；已暂停此项。'),{code:'MISSING_HASH'});
    if(organizeByAnime){
      // Only query qB when a rule/root override cannot determine the path by itself.
      if(!matchingAnimeRule(item,this.config)?.savePath?.trim()&&!this.config.qb.savePath?.trim()&&!this.defaultSavePath){const prefs=await(await this.request('app/preferences')).json();this.defaultSavePath=validateDownloadPath(prefs.save_path,'qB 默认下载目录');}
      savePath=animeDownloadPath(item,this.config,this.defaultSavePath||'');
    }
    savePath=validateDownloadPath(savePath);
    const form = new FormData();
    // Hash-backed magnets allow qB to fetch metadata itself and keep RSS tokens out of qB.
    // Prefer .torrent uploads when available: works even when magnet metadata is unavailable.
    if (item.torrentUrl || item.torrentData) {
      const b = item.torrentData || await readLimited(await safeFetch(item.torrentUrl),{label:'种子'});
      if (b.byteLength > 20_000_000 || new Uint8Array(b)[0] !== 100) throw Object.assign(new Error('下载到的文件不是有效种子。'),{code:'INVALID_TORRENT'});
      if(torrentInfoHash(b)!==item.infoHash)throw Object.assign(new Error('种子校验与预期不一致，已停止添加。'),{code:'HASH_MISMATCH'});
      form.set('torrents', new Blob([b], { type: 'application/x-bittorrent' }), 'anibt.torrent');
    } else {
      form.set('urls', item.magnet || `magnet:?xt=urn:btih:${item.infoHash}`);
    }
    const q = this.config.qb;
    if (savePath){form.set('savepath',savePath);form.set('autoTMM','false');}
    if (q.category) form.set('category', q.category);
    if (q.tags?.length) form.set('tags', q.tags.join(','));
    form.set('paused', String(stopped)); // qBittorrent 4.x
    form.set('stopped', String(stopped)); // qBittorrent 5.x
    await onSubmitting?.({savePath});
    let r;try{r=await this.request('torrents/add', form);}catch(error){error.submissionAttempted=true;throw error;}
    const responseText = (await r.text()).trim();
    // Newer qB 5.2 builds return a JSON result; older builds return Ok. or 204.
    // The hash lookup below is authoritative for every response format.
    let result;
    try { result = JSON.parse(responseText); } catch {}
    if (responseText === 'Fails.' || (result?.failure_count > 0 && !result.success_count && !result.pending_count))
      throw Object.assign(new Error('qBittorrent 明确拒绝添加；此项已暂停，请核对下载器和资源后重新排队。'),{code:'ADD_REJECTED',submissionRejected:true});
    for (let i=0; i<10; i++) { if (await this.has(item.infoHash)) return{savePath}; await sleep(500); }
    throw Object.assign(new Error('尚未在 qBittorrent 中确认到任务；下一次会先查重再重试。'),{code:'CONFIRMATION_TIMEOUT',submissionAttempted:true});
  }
  async logout() { if (this.cookie) { try { await this.request('auth/logout', new URLSearchParams()); } catch {} this.cookie = ''; } }
}
