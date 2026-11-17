/* Native dialog semantics, reversible compositor transitions, no polling. */
(() => {
  const root=document.documentElement,shell=document.querySelector('.app-shell');
  const enabled=()=>root.dataset.design==='apple';
  const original=HTMLDialogElement.prototype.showModal;
  function sync(){
    const open=enabled()&&!!document.querySelector('dialog[open]');
    root.classList.toggle('apple-sheet-open',open);
  }
  for(const dialog of document.querySelectorAll('dialog')){
    const body=document.createElement('div');body.className='apple-sheet-body';
    const children=[...dialog.children],middle=children.filter(node=>!node.classList.contains('dialog-header')&&!node.classList.contains('dialog-footer'));
    if(middle.length){middle[0].before(body);for(const node of middle)body.append(node);}
    dialog.addEventListener('close',sync);
  }
  HTMLDialogElement.prototype.showModal=function(...args){
    if(enabled()&&!document.querySelector('dialog[open]'))shell.style.setProperty('--apple-origin-y',`${scrollY+innerHeight/2}px`);
    const result=original.apply(this,args);sync();return result;
  };
  const close=HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close=function(...args){const result=close.apply(this,args);sync();return result;};
  new MutationObserver(sync).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('anibt-theme-change',sync);
  sync();
})();
