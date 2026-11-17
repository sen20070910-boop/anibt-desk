import { createHash } from 'node:crypto';

export function normalizeHash(value) {
  const hash=String(value||'').trim();if(/^[a-f\d]{40}$/i.test(hash))return hash.toLowerCase();
  if(!/^[a-z2-7]{32}$/i.test(hash))return '';
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,acc=0;const bytes=[];
  for(const ch of hash.toUpperCase()){acc=(acc<<5)|alphabet.indexOf(ch);bits+=5;if(bits>=8){bits-=8;bytes.push((acc>>bits)&255);acc&=(1<<bits)-1;}}
  return Buffer.from(bytes).toString('hex');
}
export function magnetHash(value){try{const u=new URL(value);if(u.protocol!=='magnet:')return '';for(const xt of u.searchParams.getAll('xt')){const m=xt.match(/^urn:btih:(.+)$/i);if(m){const hash=normalizeHash(m[1]);if(hash)return hash;}}}catch{}return '';}
export function torrentInfoHash(input) {
  const data=Buffer.from(input);if(data.length>12_000_000||data[0]!==100)throw new Error('下载内容不是有效的种子文件。');let info;
  function string(p){const colon=data.indexOf(58,p);if(colon<0||colon-p>9)throw new Error('种子格式错误。');const raw=data.subarray(p,colon).toString();if(!/^\d+$/.test(raw))throw new Error('种子格式错误。');const end=colon+1+Number(raw);if(end>data.length)throw new Error('种子文件不完整。');return{start:colon+1,end};}
  function skip(p,depth=0){if(depth>80||p>=data.length)throw new Error('种子格式错误。');const type=data[p];if(type>=48&&type<=57)return string(p).end;
    if(type===105){const end=data.indexOf(101,p+1);if(end<0||end-p>30||!/^(-?\d+)$/.test(data.subarray(p+1,end).toString()))throw new Error('种子格式错误。');return end+1;}
    if(type===108){p++;while(data[p]!==101)p=skip(p,depth+1);return p+1;}
    if(type===100){p++;while(data[p]!==101){const key=string(p);p=key.end;const start=p;p=skip(p,depth+1);if(depth===0&&data.subarray(key.start,key.end).toString()==='info'){if(info)throw new Error('种子包含重复信息。');info=data.subarray(start,p);}}return p+1;}
    throw new Error('种子格式错误。');
  }
  if(skip(0)!==data.length||!info||info[0]!==100)throw new Error('种子缺少有效信息。');
  return createHash('sha1').update(info).digest('hex');
}
