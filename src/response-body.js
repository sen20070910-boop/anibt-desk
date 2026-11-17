export async function readLimited(response,{maxBytes=20_000_000,label='响应'}={}){
  const tooLarge=()=>Object.assign(new Error(label+'内容过大，已停止读取。'),{code:'RESPONSE_TOO_LARGE'});
  if(Number(response.headers?.get('content-length'))>maxBytes){await response.body?.cancel().catch(()=>{});throw tooLarge();}
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel().catch(()=>{});throw tooLarge();}chunks.push(Buffer.from(value));}return Buffer.concat(chunks,total);}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
