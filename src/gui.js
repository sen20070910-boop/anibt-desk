import './runtime-guard.js';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startGui } from './gui-server.js';
const {values}=parseArgs({options:{config:{type:'string'},'no-open':{type:'boolean'},background:{type:'boolean'}}});
startGui({...(values.config?{configFile:path.resolve(values.config)}:{}),open:!values['no-open'],background:!!values.background}).catch(e=>{console.error(e.message);process.exitCode=1;});
