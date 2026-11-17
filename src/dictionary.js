export const own=(object,key)=>object&&Object.hasOwn(object,key)?object[key]:undefined;
export const put=(object,key,value)=>{Object.defineProperty(object,key,{value,writable:true,enumerable:true,configurable:true});return value;};
