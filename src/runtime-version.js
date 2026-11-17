import {MIN_NODE} from './version.js';export {MIN_NODE};
export function requireRuntime(version=process.versions.node){const m=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);if(!m||Number(m[1])<22||(Number(m[1])===22&&Number(m[2])<19))throw new Error(`需要 Node.js >=${MIN_NODE}，当前为 ${version}。请使用便携包内置运行时或升级 Node.js。`);return true;}
