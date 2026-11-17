/* One shared navigation surface. No animation frame loop or pointer tracking. */
(() => {
  const navigation=document.querySelector('.sidebar nav');
  const rail=document.createElement('span');
  rail.className='morph-nav-rail';rail.setAttribute('aria-hidden','true');
  rail.style.opacity='0';
  navigation.prepend(rail);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0, previous='', contour;
  const enabled=()=>document.documentElement.dataset.design==='morph';
  function position(){
    frame=0;
    if(!enabled()||!window.AniBTRuntime.active())return;
    const target=navigation.querySelector('.nav-item.active');
    if(!target)return;
    const item=target.getBoundingClientRect(),parent=navigation.getBoundingClientRect();
    rail.style.setProperty('--rail-y',`${item.top-parent.top}px`);
    rail.style.setProperty('--rail-height',`${item.height}px`);
    rail.style.opacity='1';
    const page=target.dataset.page;
    if(previous&&previous!==page&&!reduced.matches){
      contour?.cancel();
      contour=rail.animate([
        {borderRadius:'16px'},
        {borderRadius:'22px 12px 24px 12px',offset:.45},
        {borderRadius:'16px'}
      ],{duration:520,easing:'cubic-bezier(.22,1,.36,1)'});
    }
    previous=page;
  }
  function schedule(){
    if(!enabled()||!window.AniBTRuntime.active()){
      contour?.cancel();previous='';
      rail.style.opacity='0';
      if(frame)cancelAnimationFrame(frame);frame=0;return;
    }
    if(!frame)frame=requestAnimationFrame(position);
  }
  new ResizeObserver(schedule).observe(navigation);
  const artwork=document.querySelector('.hero-art');
  new IntersectionObserver(entries=>{
    artwork.dataset.morphVisible=entries[0].isIntersecting?'true':'false';
  }).observe(artwork);
  window.addEventListener('anibt-theme-change',schedule);
  window.addEventListener('anibt-page-change',schedule);
  window.addEventListener('anibt-activity',schedule);
  reduced.addEventListener('change',()=>{contour?.cancel();schedule();});
  schedule();
})();
