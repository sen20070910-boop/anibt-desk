import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function syncVersion({check=false}={}){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),version=pkg.version,minNode=pkg.engines.node.replace(/^>=/,'');
  if(!/^\d+\.\d+\.\d+$/.test(version)||!/^\d+\.\d+\.\d+$/.test(minNode))throw Error('Invalid version source');
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));lock.version=version;lock.packages[''].version=version;lock.packages[''].engines=pkg.engines;
  const updates=new Map([
    ['package-lock.json',JSON.stringify(lock,null,2)+'\n'],
    ['src/version.js',`// Generated from package.json; run scripts/sync-version.mjs.\nexport const APP_VERSION='${version}';\nexport const MIN_NODE='${minNode}';\n`],
  ]);
  for(const name of ['README.md','使用说明.md']){const file=path.join(root,name);let text=fs.readFileSync(file,'utf8');text=name==='README.md'?text.replace(/当前版本 v\d+\.\d+\.\d+/,'当前版本 v'+version).replace(/开发环境需要 Node.js >=\d+\.\d+\.\d+/,'开发环境需要 Node.js >='+minNode):text.replace(/^(# .*?) v\d+\.\d+\.\d+/m,'$1 v'+version);updates.set(name,text);}
  for(const [name,text]of updates){const file=path.join(root,name);if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==text){if(check)throw Error('Version drift: '+name);fs.writeFileSync(file,text);}}
  return{version,minNode};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(syncVersion({check:process.argv.includes('--check')})));
