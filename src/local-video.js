import fs from 'node:fs/promises';
import path from 'node:path';
import { episodeInReleaseTitle } from './episodes.js';
import { isRelativeTorrentPath } from './qb-files.js';
import { hasVideoExtension } from './subtitle-language.js';

export async function verifiedLocalVideo(root, name, size) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !isRelativeTorrentPath(name) || !hasVideoExtension(name)) return null;
  try {
    const realRoot = await fs.realpath(root);
    const full = await fs.realpath(path.join(realRoot, name));
    const relative = path.relative(realRoot, full);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    const stat = await fs.stat(full);
    return stat.isFile() && stat.size > 0 && (size === undefined || stat.size === size) ? full : null;
  } catch { return null; }
}

export async function collectionInventory(directory, end, start = 1) {
  if (typeof directory !== 'string' || directory.length > 1000 || !path.isAbsolute(directory))
    throw new Error('请输入本机收藏目录的完整路径。');
  const root = await fs.realpath(directory).catch(() => '');
  if (!root || root === path.parse(root).root || !(await fs.stat(root)).isDirectory())
    throw new Error('无法读取此收藏目录，请检查路径。');
  const found = new Set();
  const queue = [{ directory: root, depth: 0 }];
  let entries = 0, unknown = 0, limited = false;
  for (const folder of queue) {
    const dir = await fs.opendir(folder.directory);
    for await (const file of dir) {
      if (++entries > 3000) { limited = true; break; }
      if (file.isDirectory()) {
        if (folder.depth < 8) queue.push({ directory: path.join(folder.directory, file.name), depth: folder.depth + 1 });
        else limited = true;
      } else if (file.isFile() && hasVideoExtension(file.name)) {
        const episode = episodeInReleaseTitle(file.name.replace(/\.[^.]+$/, ''));
        if (episode) found.add(episode);
        else unknown++;
      }
    }
    if (entries > 3000) break;
  }
  const missing = [];
  for (let episode = start; episode <= end; episode++) {
    if (!found.has(episode)) missing.push(episode);
  }
  return { found: [...found].sort((a,b) => a-b), missing, unknown, limited };
}
