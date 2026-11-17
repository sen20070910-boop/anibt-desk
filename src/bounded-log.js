import fs from 'node:fs';import path from 'node:path';import{format}from'node:util';
export function appendBoundedLog(file,message,{maxBytes=2*1024*1024,keepBytes=1024*1024}={}){
 fs.mkdirSync(path.dirname(file),{recursive:true});let text=String(message);let bytes=Buffer.from(text);if(bytes.length>keepBytes)bytes=bytes.subarray(bytes.length-keepBytes);
 let size=0;try{size=fs.statSync(file).size;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(size+bytes.length>maxBytes){const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(size,keepBytes));try{fs.readSync(fd,buffer,0,buffer.length,size-buffer.length);}finally{fs.closeSync(fd);}let tail=buffer.toString('utf8');const newline=tail.indexOf('\n');if(newline>=0)tail=tail.slice(newline+1);fs.writeFileSync(file,tail);}
 fs.appendFileSync(file,bytes);
}
export function installBackgroundLogs(directory){console.log=(...args)=>appendBoundedLog(path.join(directory,'watch.log'),format(...args)+'\n');console.error=(...args)=>appendBoundedLog(path.join(directory,'watch-error.log'),format(...args)+'\n');}
