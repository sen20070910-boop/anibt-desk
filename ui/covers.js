/* Viewport-driven covers. Hidden pages never enqueue image requests. */
(() => {
  const cache = new Map(), repaired = new Set(), queued = new Set();
  const observed = new Set();
  let active = 0, scheduled = false;
  const visible = image => {
    if (!image.isConnected || !window.AniBTRuntime.active()) return false;
    if (image.closest('.page.hidden') || image.closest('dialog:not([open])')) return false;
    const box = image.getBoundingClientRect();
    return box.width > 0 && box.bottom > -200 && box.top < innerHeight + 200;
  };
  function coverSource(url, force = false) {
    if (force) cache.delete(url);
    if (cache.has(url)) {
      const row = cache.get(url); cache.delete(url); cache.set(url, row); return row;
    }
    const promise = api('anibt/image', {url}).then(row => row.src).catch(error => {
      cache.delete(url); throw error;
    });
    cache.set(url, promise);
    while (cache.size > 160) cache.delete(cache.keys().next().value);
    return promise;
  }
  async function load(image) {
    if (image.dataset.coverLoading || !visible(image)) return;
    const url = image.dataset.coverUrl;
    if (!url) return;
    image.dataset.coverLoading = '1';
    image.classList.add('cover-pending');
    image.onload = () => { image.hidden = false; image.classList.remove('cover-pending'); };
    image.onerror = async () => {
      image.hidden = true;
      const key = url + ':' + (image.dataset.coverBgm || image.dataset.coverTitle || '');
      if (repaired.has(key) || !visible(image.parentElement)) return;
      repaired.add(key);
      while (repaired.size > 64) repaired.delete(repaired.values().next().value);
      try {
        image.hidden = false;
        image.onerror = async () => {
          image.hidden = true;
          if (!image.dataset.coverTitle || !visible(image.parentElement)) return;
          try {
            const result = await api('anibt/covers', {refresh: true,
              items: [{title: image.dataset.coverTitle, bgmId: image.dataset.coverBgm || ''}]});
            const next = result.items?.[0]?.cover;
            if (next && next !== url) {
              image.dataset.coverUrl = next;
              delete image.dataset.coverLoading;
              image.hidden = false;
              queued.add(image); drain();
            }
          } catch {}
        };
        image.src = await coverSource(url, true);
      } catch { image.hidden = true; }
    };
    try { image.src = await coverSource(url); image.hidden = false; }
    catch { delete image.dataset.coverLoading; image.hidden = true; }
  }
  function drain() {
    if (!window.AniBTRuntime.active()) return;
    for (const image of queued) {
      if (active >= 3) break;
      queued.delete(image);
      if (!visible(image)) continue;
      active++;
      load(image).finally(() => { active--; drain(); });
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) queued.add(entry.target);
    drain();
  }, {rootMargin: '200px'});
  function scan() {
    scheduled = false;
    for (const image of observed) if (!image.isConnected) {
      observer.unobserve(image); observed.delete(image); queued.delete(image);
    }
    for (const image of document.querySelectorAll('img[data-cover-url]')) {
      if (!observed.has(image)) { observed.add(image); observer.observe(image); }
      if (visible(image) && !image.dataset.coverLoading) queued.add(image);
    }
    drain();
  }
  function schedule() {
    if (scheduled || !window.AniBTRuntime.active()) return;
    scheduled = true; requestAnimationFrame(scan);
  }
  new MutationObserver(records => {
    if (records.some(row => row.addedNodes.length || row.removedNodes.length || row.type === 'attributes')) schedule();
  }).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-cover-url', 'open']});
  window.addEventListener('anibt-page-change', schedule);
  window.addEventListener('anibt-activity', schedule);
  window.AniBTCovers = {refresh() {
    cache.clear(); repaired.clear();
    for (const image of observed) { delete image.dataset.coverLoading; image.hidden = false; }
    schedule();
  }};
  schedule();
})();
