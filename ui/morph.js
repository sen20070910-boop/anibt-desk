/* Follow the active navigation item in the classic and morph themes. */
(() => {
  const root=document.documentElement;
  const navigation=document.querySelector('.sidebar nav');
  const rail=document.createElement('span');
  rail.className='nav-highlight';rail.setAttribute('aria-hidden','true');
  navigation.prepend(rail);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0, previous='', design, contour;
  function position(){
    frame=0;
    if(!window.AniBTRuntime.active())return;
    const target=navigation.querySelector('.nav-item.active');
    if(!target)return;
    rail.style.setProperty('--rail-y',`${target.offsetTop}px`);
    rail.style.setProperty('--rail-height',`${target.offsetHeight}px`);
    rail.dataset.ready='';
    const page=target.dataset.page;
    if(design==='morph'&&previous&&previous!==page&&!reduced.matches){
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
    if(design!==root.dataset.design){
      design=root.dataset.design;
      delete rail.dataset.ready;
      contour?.cancel();previous='';
    }
    if(design==='apple'||!window.AniBTRuntime.active()){
      contour?.cancel();previous='';
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
