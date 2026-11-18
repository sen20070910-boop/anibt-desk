/* Animate the visible part of a view on navigation or when a request finishes. */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Set();
  const easing = 'cubic-bezier(.2,.75,.25,1)';
  const enabled = () => !reduced.matches && window.AniBTRuntime.active();
  let currentPage;

  function stop() {
    for (const animation of running) animation.cancel();
    running.clear();
  }

  function inViewport(elements) {
    const visible = [];
    for (const element of elements) {
      const bounds = element.getBoundingClientRect();
      if (bounds.height && bounds.bottom > 0 && bounds.top < innerHeight) {
        visible.push(element);
        if (visible.length === 8) break;
      }
    }
    return visible;
  }

  function animate(element, keyframes, options) {
    const animation = element.animate(keyframes, { easing, ...options });
    running.add(animation);
    animation.onfinish = animation.oncancel = () => running.delete(animation);
  }

  function reveal(elements) {
    if (!enabled()) return;
    const apple = document.documentElement.dataset.design === 'apple';
    inViewport(elements).forEach((element, index) => {
      animate(element, [
        { opacity: .24, translate: `0 ${apple ? 4 : 11}px` },
        { opacity: 1, translate: '0 0' },
      ], { duration: apple ? 230 : 350, delay: Math.min(index * 28, 126), fill: 'backwards' });
    });
  }

  window.addEventListener('anibt-page-change', ({ detail: { page } }) => {
    if (currentPage === page) return;
    currentPage = page;
    stop();
    const view = document.getElementById(`page-${page}`);
    if (!view) return;
    const content = view.querySelectorAll(page === 'overview'
      ? '.hero-content, .stat-card, .filter-strip, .section-heading'
      : ':scope > :is(.page-intro, .panel, .theme-options, .toolbar, .discovery-toolbar), .download-card');
    reveal([document.getElementById('page-title'), ...content]);
  });
  window.addEventListener('anibt-theme-change', stop);
  window.addEventListener('anibt-activity', ({ detail }) => { if (!detail.active) stop(); });
  reduced.addEventListener('change', stop);

  window.AniBTMotion = {
    results(container, selector) {
      if (container.closest('.page.hidden')) return;
      reveal(container.querySelectorAll(`${selector}, .empty-state`));
    },
    downloadProgress(container, previousTorrents) {
      if (currentPage !== 'downloads' || !enabled()) return;
      const previous = new Map(previousTorrents.map(({ hash, progress }) => [hash, progress]));
      for (const card of inViewport(container.querySelectorAll('.download-card'))) {
        const fill = card.querySelector('.progress-fill');
        const oldProgress = Math.min(1, Math.max(0, Number(previous.get(card.dataset.qbHash)) || 0));
        const progress = Number(fill.style.getPropertyValue('--download-progress'));
        if (oldProgress !== progress) {
          animate(fill, [{ scale: `${oldProgress} 1` }, { scale: `${progress} 1` }], { duration: 460 });
        }
      }
    },
  };
})();
