"use strict";
const paths = {
  home: "M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8",
  library: "M4 4h5v17H4zM12 4h4v17h-4zM19 5l3 15",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  settings:
    "M10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3zM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1",
  pause: "M8 5v14M16 5v14",
  play: "m7 4 13 8-13 8z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  check: "m5 12 4 4L19 6",
  clock: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M12 7v5l3 2",
  sliders: "M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2M11 3v6M6 9v6M14 15v6",
  external: "M14 3h7v7M21 3 11 13M10 4H4v16h16v-6",
  search: "M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0m-2 5 6 6",
  link: "m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  chevron: "m8 4 8 8-8 8",
  info: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M12 11v6M12 7h.01",
  close: "m6 6 12 12M6 18 18 6",
};
Object.assign(paths, {
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  sun: "M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7M17 12a5 5 0 1 0-10 0 5 5 0 0 0 10 0",
  moon: "M20.5 13.5A9 9 0 0 1 10.5 3a9 9 0 1 0 10 10.5",
  monitor: "M3 4h18v13H3zM12 17v4M8 21h8",
});
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
const $ = (id) => document.getElementById(id);
const escape = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const text = (id, value) => ($(id).textContent = value);
const norm = (x) =>
  String(x || "")
    .normalize("NFKC")
    .toLowerCase();
const csv = (x) =>
  x
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
const S = {
  openWatched: new URLSearchParams(location.search).get("watched") === "1",
  catalogMode: new URLSearchParams(location.search).get("catalog"),
  explicitPage: new URLSearchParams(location.search).has("page"),
  page:
    new URLSearchParams(location.search).get("page") === "subtitles"
      ? "discover"
      : [
            "downloads",
            "library",
            "subscriptions",
            "progress",
            "settings",
            "discover",
          ].includes(new URLSearchParams(location.search).get("page"))
        ? new URLSearchParams(location.search).get("page")
        : "overview",
  accountLogin: new URLSearchParams(location.search).get("anibtLogin") === "1",
  status: null,
  feed: [],
  feedLoaded: false,
  covers: new Map(),
  coverPending: new Set(),
  groups: [],
  groupOptions: [],
  groupRequest: 0,
  groupWarning: "",
  groupUpdatedAt: null,
  lastFeedAt: 0,
  qb: null,
  globalGroups: [],
  groupDraft: [],
  groupContext: "global",
  rule: null,
  ruleGroups: [],
  formDirty: false,
  formRevision: 0,
  settingsInitialized: false,
  operation: null,
  token: "",
  toastTimer: null,
  themeSaving: false,
};
for (const e of document.querySelectorAll("[data-icon]"))
  e.innerHTML = icon(e.dataset.icon);
const fragment = new URLSearchParams(location.hash.slice(1));
S.token = fragment.get("token") || sessionStorage.getItem("anibt-token") || "";
if (S.token) {
  sessionStorage.setItem("anibt-token", S.token);
  history.replaceState(null, "", location.pathname);
}
text(
  "today",
  new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date()),
);
async function api(endpoint, body) {
  return window.AniBTRuntime.request(endpoint, body, S.token);
}
function renderMarkup(id, markup) {
  const element = $(id);
  if (element.__markup === markup) return;
  element.__markup = markup;
  element.innerHTML = markup;
}
function toast(message, error = false) {
  clearTimeout(S.toastTimer);
  text("toast", message);
  $("toast").className = "toast" + (error ? " error-toast" : "");
  S.toastTimer = setTimeout(
    () => $("toast").classList.add("hidden"),
    error ? 6500 : 3500,
  );
}
function showError(message) {
  text("global-error", message);
  $("global-error").classList.toggle("hidden", !message);
}
function date(value) {
  if (!value) return "尚未检查";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + units[i];
}
function empty(title, description, type = "library") {
  return `<div class="empty-state"><span class="empty-icon">${icon(type)}</span><strong>${escape(title)}</strong><p>${escape(description)}</p></div>`;
}
function changePage(page) {
  if (page === "subtitles") page = "discover";
  S.page = page;
  window.AniBTSession?.page(page);
  for (const el of document.querySelectorAll(".page"))
    el.classList.toggle("hidden", el.id !== "page-" + page);
  for (const el of document.querySelectorAll(".nav-item")) {
    el.classList.toggle("active", el.dataset.page === page);
    el.setAttribute(
      "aria-current",
      el.dataset.page === page ? "page" : "false",
    );
  }
  text(
    "page-title",
    {
      overview: "追番总览",
      discover: "发现资源",
      subscriptions: "追番管理",
      library: "番剧订阅",
      downloads: "下载记录",
      settings: "偏好设置",
      progress: "追番进度",
      help: "使用说明",
    }[page],
  );
  if (page === "settings" && !S.settingsInitialized) fillSettings();
  renderFeed();
  if (page === "downloads") {
    loadLogs();
    void loadQb().catch(() => {});
  }
  if (["overview", "subscriptions"].includes(page)) {
    if (!S.feedLoaded || Date.now() - S.lastFeedAt >= 60000)
      void loadFeed().catch(() => {});
    else void loadFeedCovers();
  }
  if (page === "progress") window.AniBTWorkbench?.load();
  if (page === "help") window.AniBTHelp?.open();
  if (page === "discover") window.AniBTDiscover?.enter();
  if (page === "library") window.AniBTLibrary?.enter();
  window.scrollTo({ top: 0, behavior: "instant" });
  window.dispatchEvent(
    new CustomEvent("anibt-page-change", { detail: { page } }),
  );
}
function groupLabel(value) {
  return (
    S.groups.find((g) => [g.name, g.slug].some((s) => norm(s) === norm(value)))
      ?.name || value
  );
}
function statusBadge(item) {
  const labels = {
    excluded: "已过滤",
    recorded: "已处理",
    duplicate: "同集已处理",
    baseline: "已有资源",
    waiting: "等待发布组补位",
    candidate: "待检查的新发布",
  };
  const cls =
    item.status === "excluded"
      ? ""
      : item.status === "candidate"
        ? "success"
        : item.status === "baseline"
          ? ""
          : "success";
  return `<span class="badge ${cls}">${escape(labels[item.status])}</span>`;
}
function animeList() {
  const map = new Map();
  for (const item of S.feed.filter((i) => !i.inWatchedLibrary)) {
    const name = item.animeTitle || "未命名番剧";
    if (!map.has(name))
      map.set(name, { title: name, bgmId: item.bgmId, items: [] });
    const anime = map.get(name);
    if (!anime.bgmId && item.bgmId) anime.bgmId = item.bgmId;
    anime.items.push(item);
  }
  return [...map.values()].map((anime) => ({
    ...anime,
    cover:
      S.covers.get(
        anime.bgmId
          ? "bgm:" + anime.bgmId
          : "title:" + norm(anime.title).trim(),
      ) || "",
  }));
}
function matchingRule(anime) {
  return S.status?.config.rules.find((r) =>
    r.bgmId
      ? String(r.bgmId) === anime.bgmId
      : norm(anime.title).includes(norm(r.title)),
  );
}
function animeCard(anime, index) {
  const rule = matchingRule(anime);
  const episodes = anime.items
    .map((i) => Number(i.episode))
    .filter(Number.isFinite);
  const latest = episodes.length ? Math.max(...episodes) : "?";
  const groups = [
    ...new Set(anime.items.map((i) => i.groupName).filter(Boolean)),
  ];
  const colors = [
    ["#a69bc8", "#ddd2e8"],
    ["#9fb8bb", "#d7e3de"],
    ["#c9adab", "#f0dfd1"],
  ][index % 3];
  return `<article class="anime-card"><div class="anime-poster" role="button" tabindex="0" data-resource-index="${index}" style="--poster-start:${colors[0]};--poster-end:${colors[1]}"><span class="poster-number">ANIME / ${String(index + 1).padStart(2, "0")}</span><span class="poster-text">${escape(anime.title.slice(0, 7))}</span>${anime.cover ? `<img data-cover-url="${escape(anime.cover)}" data-cover-title="${escape(anime.items[0]?.linkedTitle || anime.title)}" data-cover-bgm="${escape(anime.bgmId)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}</div><div class="anime-details"><h3 role="button" tabindex="0" data-resource-index="${index}" title="点击查看已有资源：${escape(anime.title)}">${escape(anime.title)}</h3><div class="anime-meta"><span class="badge success">${rule?.enabled === false ? "已暂停" : "订阅中"}</span><span>最新第 ${escape(latest)} 集</span><span>${anime.items.length} 条发布</span></div><div class="anime-groups" title="${escape(groups.join(" · "))}">${escape(groups.join(" · "))}</div><div class="anime-location" title="${escape(rule?.savePath || anime.items[0]?.folderName || anime.title)}">${rule?.savePath ? "指定目录：" + escape(rule.savePath) : "自动归档到「" + escape(anime.items[0]?.folderName || anime.title) + "」"}</div><div class="anime-foot"><button type="button" class="text-button" data-resource-index="${index}">已有资源 / 选集下载</button><button type="button" class="text-button" data-bind-index="${index}">关联番剧 / 别名</button><button class="text-button" data-rule-index="${index}">单独设置 ↗</button></div></div></article>`;
}
function releaseTable(items) {
  if (!items.length)
    return empty("暂时没有匹配的资源", "试试调整搜索词或筛选条件。", "search");
  return `<table><thead><tr><th>资源 / 番剧</th><th>集数</th><th>压制组</th><th>字幕</th><th>匹配状态</th></tr></thead><tbody>${items.map((i) => `<tr><td><a class="resource-title" href="https://anibt.net/release/${encodeURIComponent(i.id)}" target="_blank" rel="noopener noreferrer" title="${escape(i.title)}">${escape(i.animeTitle || i.title)}</a><span class="resource-sub">${escape(i.title)}</span></td><td>${escape(i.episode || "—")}${i.version && i.version !== "v1" ? ` <small>${escape(i.version)}</small>` : ""}</td><td>${escape(i.groupName || i.groupSlug || "未知组")}</td><td>${i.languages.includes("CHS") ? "简中" + (i.languages.includes("CHT") ? " / 繁中" : "") : i.languages.includes("CHT") ? "繁中" : escape(i.languages.join(" / ") || "未知")}</td><td>${statusBadge(i)}<small class="decision-note">${escape(i.decision || i.reason || "")}</small></td></tr>`).join("")}</tbody></table>`;
}
function renderFeed() {
  const animes = animeList();
  text("nav-count", S.feedLoaded ? animes.length : "—");
  text("anime-count", S.feedLoaded ? `${animes.length} 部` : "");
  text("stat-animes", S.feedLoaded ? animes.length : "—");
  text(
    "stat-matched",
    S.feedLoaded ? S.feed.filter((i) => i.matched).length : "—",
  );
  const markup = animes.length
    ? animes.map(animeCard).join("")
    : empty(
        S.feedLoaded && S.feed.some((i) => i.inWatchedLibrary)
          ? "已看过的番已收纳"
          : S.feedLoaded
            ? "你的追番清单，等一个新故事"
            : "正在读取你的订阅",
        S.feedLoaded && S.feed.some((i) => i.inWatchedLibrary)
          ? "到追番管理右上角“我看过的”查看，移回在追后会恢复显示。"
          : S.feedLoaded
            ? "在 AniBT 网站订阅喜欢的番剧，资源更新后会自动出现在这里。"
            : "正在连接 AniBT，请稍候。",
      );
  if (S.page === "overview") renderMarkup("anime-cards", markup);
  if (S.page === "subscriptions") renderMarkup("subscription-cards", markup);
  if (S.page === "overview")
    renderMarkup(
      "recent-table",
      S.feedLoaded
        ? releaseTable(S.feed.filter((i) => !i.inWatchedLibrary).slice(0, 6))
        : empty("正在整理最新发布", "稍后会显示真实的订阅资源。"),
    );
  if (S.page === "subscriptions") renderReleaseList();
}
function renderReleaseList() {
  const query = norm($("release-search").value);
  const filter = $("release-filter").value;
  const items = S.feed.filter(
    (i) =>
      !i.inWatchedLibrary &&
      (!query ||
        norm(i.title + " " + i.animeTitle + " " + i.groupName).includes(
          query,
        )) &&
      (filter === "all" || (filter === "matched" ? i.matched : !i.matched)),
  );
  text("release-count", `${items.length} 条`);
  renderMarkup("all-release-table", releaseTable(items));
}

let statusPromise = null,
  feedLoadPromise = null,
  qbLoadPromise = null,
  feedLoadForced = false,
  qbLoadForced = false;

async function loadFeed(force = false) {
  if (feedLoadPromise) {
    if (force && !feedLoadForced)
      return feedLoadPromise.catch(() => {}).then(() => loadFeed(true));
    return feedLoadPromise;
  }
  feedLoadForced = force;
  feedLoadPromise = readFeedUi(force).finally(() => (feedLoadPromise = null));
  return feedLoadPromise;
}
async function readFeedUi(force = false) {
  const result = await api("feed" + (force ? "?refresh=1" : ""));
  S.feed = result.items;
  S.feedLoaded = true;
  S.lastFeedAt = Date.now();
  text(
    "feed-updated",
    `最近同步 · ${date(result.fetchedAt)}，共 ${S.feed.length} 条发布`,
  );
  renderFeed();
  void loadFeedCovers(force);
  if ($("groups-dialog").open) await reloadGroupOptions(force);
}

async function refreshAll(force = false) {
  $("refresh-button").classList.add("spin");
  try {
    await loadStatus();
    $("loading").classList.add("hidden");
    changePage(S.status.configurationError ? "settings" : S.page);
    if (S.status.configurationError) {
      showError(S.status.configurationError);
      return;
    }
    const results = await Promise.allSettled([
      ...(["overview", "subscriptions"].includes(S.page)
        ? [loadFeed(force)]
        : []),
      ...(["overview", "downloads"].includes(S.page) ? [loadQb(force)] : []),
      ...(force && S.page === "discover"
        ? [window.AniBTDiscover.refresh()]
        : []),
      ...(force && S.page === "library" ? [window.AniBTLibrary.refresh()] : []),
    ]);
    const errors = results
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason.message);
    showError(errors.join("；") || S.status.configurationError || "");
  } catch (e) {
    $("loading").classList.add("hidden");
    showError(e.message);
    changePage("settings");
  } finally {
    $("refresh-button").classList.remove("spin");
  }
}
async function doAction(action, extra = {}) {
  if (S.operation) throw new Error("正在执行操作，请稍候。");
  S.operation = action;
  renderStatus();
  try {
    const result = await api("action", { action, ...extra });
    await loadStatus();
    if (result.report) {
      await Promise.allSettled([loadFeed(), loadQb(true)]);
      toast(
        `${result.report.feedError ? "订阅刷新失败，已处理已有队列：" : "检查完成："}新增 ${result.report.added}，已处理 ${result.report.existing}，待重试 ${result.report.failed}`,
        !!result.report.failed || !!result.report.feedError,
      );
    } else
      toast(
        {
          start: "自动追番已启动",
          stop: "自动追番已暂停，记录已保留",
          "autostart-on": "已开启登录自动启动",
          "autostart-off": "已关闭登录自动启动",
        }[action] || "操作完成",
      );
    return result;
  } finally {
    S.operation = null;
    renderStatus();
  }
}
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

async function previewBackfill() {
  return window.AniBTBackfill.open();
}
document.addEventListener("click", (e) => {
  const page = e.target.closest("[data-page],[data-go]");
  if (page) {
    e.preventDefault();
    changePage(page.dataset.page || page.dataset.go);
  }
  const rule = e.target.closest("[data-rule-index]");
  if (rule) openRule(Number(rule.dataset.ruleIndex));
  const close = e.target.closest(".close-dialog");
  if (close) close.closest("dialog")?.close();
  const remove = e.target.closest("[data-remove-group]");
  if (remove) {
    S.groupDraft.splice(Number(remove.dataset.removeGroup), 1);
    renderGroups();
  }
});
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  changePage("overview");
});
$("refresh-button").addEventListener(
  "click",
  guarded(() => refreshAll(true)),
);
$("check-button").addEventListener(
  "click",
  guarded(() => doAction("check")),
);
$("toggle-watcher").addEventListener(
  "click",
  guarded(() => doAction(S.status.background.running ? "stop" : "start")),
);
$("edit-filters").addEventListener("click", () => changePage("settings"));
$("release-search").addEventListener("input", renderReleaseList);
$("release-filter").addEventListener("change", renderReleaseList);
$("refresh-downloads").addEventListener(
  "click",
  guarded(async () => {
    await loadQb(true);
    toast("下载状态已刷新。");
  }),
);
$("refresh-logs").addEventListener("click", loadLogs);
$("settings-form").addEventListener("input", () => {
  S.formDirty = true;
  text("settings-saved-hint", "有未保存的更改");
});
$("settings-form").addEventListener("change", () => {
  S.formDirty = true;
  text("settings-saved-hint", "有未保存的更改");
});
$("settings-form").addEventListener(
  "submit",
  guarded(async (e) => {
    e.preventDefault();
    await saveSettings();
  }),
);
$("test-connection").addEventListener(
  "click",
  guarded(() => saveSettings(true)),
);
$("select-global-groups").addEventListener(
  "click",
  guarded(() => chooseGroups("global")),
);
$("select-rule-groups").addEventListener(
  "click",
  guarded(() => chooseGroups("rule")),
);
$("group-search").addEventListener("input", renderGroups);
$("group-options").addEventListener("change", (e) => {
  const value = e.target.dataset.groupSlug;
  if (!value) return;
  const group = S.groups.find((g) => g.slug === value) || {
    name: value,
    slug: value,
  };
  S.groupDraft = S.groupDraft.filter(
    (g) => ![group.name, group.slug].some((s) => norm(s) === norm(g)),
  );
  if (e.target.checked) S.groupDraft.push(value);
  renderGroups();
});
$("refresh-groups").addEventListener(
  "click",
  guarded(() => reloadGroupOptions(true)),
);
$("clear-groups").addEventListener("click", () => {
  S.groupDraft = [];
  renderGroups();
});
$("confirm-groups").addEventListener("click", () => {
  if (S.groupContext === "global") {
    S.globalGroups = [...S.groupDraft];
    text(
      "global-group-label",
      S.globalGroups.length
        ? S.globalGroups.map(groupLabel).join("、")
        : "不限压制组",
    );
    S.formDirty = true;
    text("settings-saved-hint", "有未保存的更改");
  } else {
    S.ruleGroups = [...S.groupDraft];
    renderRuleGroupLabel();
  }
  $("groups-dialog").close();
});
$("rule-inherit-groups").addEventListener("change", renderRuleGroupLabel);
$("save-rule").addEventListener(
  "click",
  guarded(() => saveRule()),
);
$("reset-rule").addEventListener(
  "click",
  guarded(() => saveRule(true)),
);
$("backfill-button").addEventListener("click", guarded(previewBackfill));
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      if (dialog.dataset.busy === "1") return;
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        dialog.close();
    }
  });

window.addEventListener("anibt-theme-change", syncThemeControls);
syncThemeControls();
$("theme-button").addEventListener(
  "click",
  guarded(() => {
    const mode = window.AniBTTheme.get();
    return setTheme(
      mode === "light"
        ? "dark"
        : mode === "dark"
          ? "system"
          : document.documentElement.dataset.theme === "dark"
            ? "light"
            : "dark",
    );
  }),
);
for (const button of document.querySelectorAll("[data-theme-mode]"))
  button.addEventListener(
    "click",
    guarded(() => setTheme(button.dataset.themeMode)),
  );
if (!S.token) {
  $("loading").classList.add("hidden");
  showError("请双击「打开图形界面」启动此应用，当前窗口缺少访问凭据。");
} else {
  renderFeed();
  refreshAll();
  window.AniBTRuntime.register(
    "main",
    async () => {
      await loadStatus();
      if (
        ["overview", "subscriptions"].includes(S.page) &&
        Date.now() - S.lastFeedAt >= 60000 &&
        !S.operation
      )
        await loadFeed();
      if (S.page === "downloads") await loadQb();
    },
    { intervalMs: 15000 },
  );
}

$("test-notifications").addEventListener(
  "click",
  guarded(async () => {
    const b = $("test-notifications");
    b.disabled = true;
    try {
      await api("notifications/test", {});
      toast("测试通知已发送，请查看 Windows 通知中心。");
    } finally {
      b.disabled = false;
    }
  }),
);

$("notifications-button").addEventListener(
  "click",
  guarded(async () => {
    const n = await api("notifications");
    if (S.status) S.status.notifications = n;
    renderNotifications();
    $("notifications-dialog").showModal();
  }),
);
$("notifications-read-all").addEventListener(
  "click",
  guarded(() =>
    markNotificationIds(
      S.status.notifications.items.filter((i) => !i.read).map((i) => i.id),
    ),
  ),
);
$("notifications-list").addEventListener(
  "click",
  guarded((e) => {
    const b = e.target.closest("[data-read-notification]");
    if (b) return markNotificationIds([b.dataset.readNotification]);
  }),
);

$("rule-inherit-start-date").addEventListener("change", updateRuleStartDate);

$("rule-inherit-start-episode").addEventListener(
  "change",
  updateRuleStartEpisode,
);
$("setting-episode-only").addEventListener(
  "click",
  guarded(() => {
    if (!$("setting-start-episode").value)
      throw new Error("请先填写开始追番集数。");
    $("setting-start-date").value = "";
    $("setting-start-date").dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    toast("日期限制已清空，点击保存后生效。");
  }),
);
$("rule-episode-only").addEventListener(
  "click",
  guarded(() => {
    const episode = $("rule-inherit-start-episode").checked
      ? S.status.config.startEpisode
      : $("rule-start-episode").value;
    if (!episode) throw new Error("请先填写开始集数，或设置默认开始集数。");
    $("rule-inherit-start-date").checked = false;
    $("rule-start-date").value = "";
    updateRuleStartDate();
    toast("本番日期限制已清空，保存偏好后生效。");
  }),
);

document.addEventListener(
  "click",
  guarded((e) => {
    const b = e.target.closest("[data-resource-index]");
    if (b)
      return window.AniBTResources.open(
        animeList()[Number(b.dataset.resourceIndex)],
      );
  }),
);
document.addEventListener(
  "keydown",
  guarded((e) => {
    if (!["Enter", " "].includes(e.key) || e.target.tagName === "BUTTON")
      return;
    const b = e.target.closest("[data-resource-index]");
    if (b) {
      e.preventDefault();
      return window.AniBTResources.open(
        animeList()[Number(b.dataset.resourceIndex)],
      );
    }
  }),
);

async function loadFeedCovers(force = false) {
  if (
    !window.AniBTRuntime.active() ||
    !["overview", "subscriptions"].includes(S.page)
  )
    return;
  const visible = new Set(
    [...document.querySelectorAll("#page-" + S.page + " [data-resource-index]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom >= -250 && r.top <= innerHeight + 250;
      })
      .map((el) => Number(el.dataset.resourceIndex)),
  );
  const list = animeList()
      .filter((_, i) => visible.has(i))
      .map((i) => ({
        title: i.items[0]?.linkedTitle || i.title,
        bgmId: i.bgmId || "",
      })),
    keyOf = (i) =>
      i.bgmId ? "bgm:" + i.bgmId : "title:" + norm(i.title).trim();
  const needed = list.filter(
    (i) => !S.coverPending.has(keyOf(i)) && (force || !S.covers.has(keyOf(i))),
  );
  for (const i of needed) S.coverPending.add(keyOf(i));
  for (let start = 0; start < needed.length; start += 60) {
    const chunk = needed.slice(start, start + 60);
    try {
      const r = await api("anibt/covers", { items: chunk, refresh: force });
      for (const i of r.items || []) S.covers.set(i.key, i.cover || "");
    } catch {
    } finally {
      for (const i of chunk) S.coverPending.delete(keyOf(i));
    }
  }
  if (needed.length) renderFeed();
}
for (const id of ["anime-cards", "subscription-cards"])
  $(id).addEventListener(
    "error",
    (e) => {
      if (e.target.tagName === "IMG") e.target.hidden = true;
    },
    true,
  );

let coverScrollTimer;
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(coverScrollTimer);
    coverScrollTimer = setTimeout(() => void loadFeedCovers(), 160);
  },
  { passive: true },
);
window.addEventListener("anibt-activity", (e) => {
  if (e.detail.active) void loadFeedCovers();
});

for (const button of document.querySelectorAll("[data-design-mode]"))
  button.addEventListener(
    "click",
    guarded(() => setDesign(button.dataset.designMode)),
  );
