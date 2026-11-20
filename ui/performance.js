/* Shared request and visibility scheduling for the local desktop UI. */
(() => {
  const reads = new Map();
  const jobs = new Map();
  let nativeHidden = false;
  let generation = 0;
  let timer;

  const active = () => !document.hidden && !nativeHidden;
  let previouslyActive = active();
  const readOnlyPosts = new Set(['anibt/covers', 'anibt/image', 'discover/tasks', 'discover/files', 'history/subtitles', 'library/check-update']);
  async function request(endpoint, body, token) {
    const isRead = body === undefined;
    const forced = /[?&]refresh=1(?:&|$)/.test(endpoint);
    const existing = reads.get(endpoint);
    if (isRead && !forced && existing &&
        (existing.pending || Date.now() - existing.at < 1200)) return existing.promise;
    if (!isRead && !readOnlyPosts.has(endpoint.split('?')[0])) {
      generation++;
      reads.clear();
    }
    const revision = generation;
    const row = {at: Date.now(), pending: true};
    row.promise = (async () => {
      const response = await fetch('/api/' + endpoint, {
        headers: {'X-App-Token': token, ...(isRead ? {} : {'Content-Type': 'application/json'})},
        ...(isRead ? {} : {method: 'POST', body: JSON.stringify(body)})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试。');
      return data;
    })();
    if (isRead && !forced) reads.set(endpoint, row);
    try { return await row.promise; }
    catch (error) { if (reads.get(endpoint) === row) reads.delete(endpoint); throw error; }
    finally {
      row.pending = false;
      row.at = Date.now();
      if (revision !== generation && reads.get(endpoint) === row) reads.delete(endpoint);
      // Bound transient responses, including search/filter URL variants.
      while (reads.size > 48) {
        const key = [...reads].find(([, value]) => !value.pending)?.[0];
        if (key === undefined) break;
        reads.delete(key);
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!active()) return;
    const pending = [...jobs.values()].filter(job => !job.running && job.enabled());
    if (!pending.length) return;
    const delay = Math.max(30, Math.min(...pending.map(job => job.next - Date.now())));
    timer = setTimeout(run, delay);
  }
  function run() {
    if (!active()) return;
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.running || !job.enabled() || now < job.next) continue;
      job.running = true;
      job.next = now + job.intervalMs;
      Promise.resolve().then(job.callback).catch(() => {}).finally(() => {
        job.running = false;
        job.next = Date.now() + job.intervalMs;
        schedule();
      });
    }
    schedule();
  }
  function visibilityChanged() {
    const awake = active();
    if (awake && !previouslyActive) {
      generation++; reads.clear();
      for (const job of jobs.values()) if (job.enabled()) job.next = Date.now();
    }
    previouslyActive = awake;
    document.documentElement.classList.toggle('ui-paused', !awake);
    window.dispatchEvent(new CustomEvent('anibt-activity', {detail: {active: awake}}));
    schedule();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.chrome?.webview?.addEventListener('message', event => {
    if (event.data?.type !== 'window-state') return;
    nativeHidden = event.data.hidden === true;
    visibilityChanged();
  });
  window.addEventListener('anibt-page-change', schedule);
  window.AniBTRuntime = {
    active, request,
    register(key, callback, {intervalMs, enabled = () => true}) {
      jobs.set(key, {callback, intervalMs, enabled, next: Date.now() + intervalMs, running: false});
      schedule();
    },
    invalidate() { generation++; reads.clear(); }
  };
  visibilityChanged();
})();
