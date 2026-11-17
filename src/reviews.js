export function validateReview(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('评价内容无效。');
  const {score,text}=value;
  if(score!==null&&(typeof score!=='number'||!Number.isFinite(score)||score<0||score>10||!Number.isInteger(score*2)))throw new Error('个人评分需为 0–10 分，可使用半分，也可以暂不评分。');
  if(typeof text!=='string'||text.length>20000)throw new Error('评价最多 20000 字符。');
  if(value.rewatch!==undefined&&typeof value.rewatch!=='boolean')throw new Error('重温标记无效。');
  return {score,rewatch:value.rewatch===true,text:text.replace(/\r\n/g,'\n')};
}
