/* Theme bootstrap runs before CSS to avoid flashing the wrong palette. */
(() => {
  const media=matchMedia('(prefers-color-scheme: dark)');
  const validMode=value=>['system','light','dark'].includes(value);
  const validDesign=value=>['classic','morph','apple'].includes(value);
  let preference=document.documentElement.dataset.themePreference||'system';
  let design=validDesign(document.documentElement.dataset.design)?document.documentElement.dataset.design:'classic';
  let applied=false;
  try {
    if(!document.documentElement.dataset.themePreference&&validMode(localStorage.getItem('anibt-theme')))preference=localStorage.getItem('anibt-theme');
    if(!document.documentElement.dataset.design&&validDesign(localStorage.getItem('anibt-design')))design=localStorage.getItem('anibt-design');
  } catch {}
  function sync(){
    const resolved=preference==='system'?(media.matches?'dark':'light'):preference;
    const root=document.documentElement;
    if(applied&&root.dataset.theme===resolved&&root.dataset.themePreference===preference&&root.dataset.design===design)return;
    applied=true;
    root.dataset.theme=resolved;root.dataset.themePreference=preference;root.dataset.design=design;
    try {localStorage.setItem('anibt-theme',preference);localStorage.setItem('anibt-design',design);}catch{}
    try {window.chrome?.webview?.postMessage({type:'theme',theme:resolved,design});}catch{}
    window.dispatchEvent(new Event('anibt-theme-change'));
  }
  const apply=value=>{preference=validMode(value)?value:'system';sync();};
  const setDesign=value=>{design=validDesign(value)?value:'classic';sync();};
  media.addEventListener('change',()=>{if(preference==='system')sync();});
  window.AniBTTheme={apply,get:()=>preference,setDesign,getDesign:()=>design,
    applyPreferences(value){preference=validMode(value.theme)?value.theme:'system';design=validDesign(value.design)?value.design:'classic';sync();}};
  sync();
})();
