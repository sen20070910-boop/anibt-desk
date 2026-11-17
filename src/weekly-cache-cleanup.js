import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from './config.js';
import { lock } from './runner.js';

const week = 7 * 86400_000;
const profiles = ['webview-profile', 'anibt-account-profile'];
const caches = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];
const canonical = file => process.platform === 'win32' ? file.toLowerCase() : file;

function webViewActive(directory) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='AniBT.exe' OR Name='msedgewebview2.exe'\" -ErrorAction Stop | ForEach-Object { if($_.Name -eq 'AniBT.exe' -or !$_.CommandLine){'ANIBT_BUSY'}else{$_.CommandLine} }",
  ], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  if (result.status !== 0) return true;
  const commands = result.stdout.replaceAll('/', '\\').toLowerCase();
  return commands.includes('anibt_busy') || profiles.some(profile =>
    commands.includes(path.join(directory, profile).toLowerCase()));
}

function inspect(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || canonical(fs.realpathSync(file)) !== canonical(file))
      throw new Error('缓存路径包含链接，已跳过。');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function clearDirectory(directory) {
  if (!inspect(directory)?.isDirectory()) return 0;
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = inspect(file);
    if (stat?.isDirectory()) {
      bytes += clearDirectory(file);
      fs.rmdirSync(file);
    } else if (stat?.isFile()) {
      fs.unlinkSync(file);
      bytes += stat.size;
    }
  }
  return bytes;
}

export function weeklyCacheCleanup(directory, { active = webViewActive, now = Date.now } = {}) {
  directory = path.resolve(directory);
  const marker = path.join(directory, 'weekly-cache-cleanup.json');
  let nextCheck = 0;
  return () => {
    const time = now();
    if (time < nextCheck) return null;
    nextCheck = time + 5 * 60_000;
    let release;
    try {
      if (!inspect(directory)?.isDirectory()) return null;
      try {
        const last = Date.parse(JSON.parse(fs.readFileSync(marker, 'utf8')).lastRunAt);
        if (last <= time && last + week > time) {
          nextCheck = last + week;
          return null;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      // The GUI holds this lock for its lifetime. Also check for native processes
      // that may still be winding down after the GUI server exits.
      try { release = lock(path.join(directory, 'gui.lock')); }
      catch { return null; }
      if (active(directory)) return null;
      let bytes = 0;
      for (const profile of profiles) {
        for (const cache of caches) {
          bytes += clearDirectory(path.join(directory, profile, 'EBWebView', 'Default', cache));
        }
      }
      atomicWrite(marker, { lastRunAt: new Date(time).toISOString(), bytes });
      nextCheck = time + week;
      return { bytes };
    } finally {
      release?.();
    }
  };
}
