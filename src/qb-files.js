import path from 'node:path';
import { readLimited } from './response-body.js';

export function isRelativeTorrentPath(name) {
  return typeof name === 'string' && !!name && name.length <= 1024 &&
    !/[:\x00-\x1f]/.test(name) && !path.win32.isAbsolute(name) &&
    !name.split(/[\\/]/).some(part => !part || part === '..' || part === '.');
}

export async function readQbFiles(qb, hash) {
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('下载任务标识无效。');
  const response = await qb.request('torrents/files', null, '?hash=' + hash);
  const files = JSON.parse((await readLimited(response, { maxBytes: 4_000_000, label: '文件清单' })).toString('utf8'));
  if (!Array.isArray(files) || !files.length || files.length > 3000 ||
      new Set(files.map(file => file?.index)).size !== files.length ||
      files.some(file => !Number.isSafeInteger(file?.index) || file.index < 0 ||
        !isRelativeTorrentPath(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isFinite(file.progress) || file.progress < 0 || file.progress > 1 ||
        !Number.isSafeInteger(file.priority) || file.priority < 0))
    throw new Error('qB 文件清单还未就绪或无法核对，请稍后刷新。');
  return files.sort((a, b) => a.index - b.index);
}
