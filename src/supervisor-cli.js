import './runtime-guard.js';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {supervise} from './supervisor.js';

const {values} = parseArgs({options: {config: {type: 'string'}}});
const configFile = path.resolve(values.config || 'config.json');
supervise({configFile, entry: path.join(path.dirname(configFile), 'dist/anibt-qb.mjs')})
  .catch(() => { console.error('后台守护启动失败，请查看本机配置和运行状态。'); process.exitCode = 1; });
