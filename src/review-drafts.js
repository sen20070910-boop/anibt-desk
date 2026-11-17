import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {atomicWrite} from './config.js';import {validateReview} from './reviews.js';
const version=value=>createHash('sha256').update(JSON.stringify(value||null)).digest('hex');
const filename=file=>path.join(path.dirname(file),'data/review-drafts.json');
export function readDrafts(file){try{const value=JSON.parse(fs.readFileSync(filename(file),'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_DRAFTS');return value;}catch(e){if(e.code==='ENOENT')return{};throw new Error('评价草稿无法读取，请保留输入并检查文件。');}}
export function getReviewDraft(file,key){const draft=readDrafts(file)[key]||null;return{draft,draftVersion:version(draft)};}
export function writeReviewDraft(file,key,input){const drafts=readDrafts(file),old=drafts[key]||null;if(input.draftVersion!==version(old))throw Object.assign(new Error('草稿已在其他窗口修改，请重新打开后恢复，当前输入未覆盖。'),{status:409});if(input.remove===true)delete drafts[key];else drafts[key]={...validateReview(input),baseVersion:input.baseVersion,updatedAt:new Date().toISOString()};atomicWrite(filename(file),drafts);return getReviewDraft(file,key);}
export function clearReviewDraft(file,key){const drafts=readDrafts(file);delete drafts[key];atomicWrite(filename(file),drafts);}
