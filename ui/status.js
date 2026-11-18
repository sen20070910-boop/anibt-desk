function renderStatus() {
  if (!S.status) return;
  const { config: c, state, background: bg, busy } = S.status;
  const active = bg.running;
  const operating = S.operation || busy;
  text(
    "hero-status",
    operating
      ? {
          check: "正在检查更新…",
          backfill: "正在补下载…",
          start: "正在启动…",
          stop: "正在暂停…",
          "manual-add": "正在添加资源…",
          "website-subscription": "正在同步网站订阅…",
        }[operating] || "正在应用设置…"
      : bg.restarting
        ? "后台异常，正在自动恢复"
        : active
          ? "自动追番运行中"
          : "自动追番已暂停",
  );
  $("hero-dot").classList.toggle("off", !active);
  $("sidebar-dot").classList.toggle("off", !active);
  text(
    "hero-description",
    active
      ? `每 ${c.intervalSeconds / 60} 分钟检查你的订阅，符合偏好的新发布会自动下载。${bg.supervised ? (bg.restarting ? " · 守护正在恢复后台" : bg.heartbeatHealthy ? " · 守护已开启，心跳正常" : " · 守护已开启，等待心跳") : ""}`
      : "你的追番记录已保留。启动后继续接收新发布。",
  );
  $("toggle-watcher").innerHTML =
    icon(active ? "pause" : "play") +
    `<span>${active ? "暂停自动追番" : "启动自动追番"}</span>`;
  $("toggle-watcher").disabled = !!operating;
  $("check-button").disabled = !!operating;
  $("backfill-button").disabled = !!operating;
  $("check-button").classList.toggle("spin", operating === "check");
  text("stat-added", state.added);
  text("stat-pending", state.pending);
  const filters = [];
  if (c.filters.languages.length)
    filters.push([
      c.filters.languages.includes("CHS")
        ? "含简中"
        : "字幕：" + c.filters.languages.join(" / "),
      "green",
    ]);
  else filters.push(["字幕不限", "gray"]);
  filters.push([
    c.filters.groups.length
      ? c.filters.groups.map(groupLabel).join(" · ")
      : "压制组不限",
    "",
  ]);
  filters.push([
    c.filters.resolutions.length
      ? c.filters.resolutions.join(" / ")
      : "画质不限",
    "gray",
  ]);
  if (c.dedupeEpisodes) filters.push(["同集去重", "gray"]);
  if (c.startEpisode)
    filters.push(["从第 " + c.startEpisode + " 集起", "gray"]);
  if (c.startDate) filters.push(["从 " + c.startDate + " 起", "gray"]);
  $("active-filters").innerHTML = filters
    .map(
      ([name, color]) => `<span class="pill ${color}">${escape(name)}</span>`,
    )
    .join("");
  text(
    "last-check",
    state.updatedAt ? "上次检查 · " + date(state.updatedAt) : "尚未开始检查",
  );
  const rows = state.history;
  $("history-list").innerHTML = rows.length
    ? rows
        .map(
          (x) =>
            `<div class="history-row">${icon("check")}<div><strong title="${escape(x.title)}">${escape(x.title)}</strong><small>${date(x.at)} · ${x.kind === "manual" ? "搜索添加 · " : ""}${x.status === "added" ? "已添加到 qBittorrent" : "qB 中已存在"}</small></div><button type="button" class="text-button" data-history-details="${escape(x.reprocessKey)}" title="查看文件状态、打开保存目录、定位任务或访问发布页">快捷操作 / 文件状态</button><button type="button" class="text-button" data-history-reprocess="${escape(x.reprocessKey)}" ${!x.canReprocess || operating ? "disabled" : ""}>重新处理</button></div>`,
        )
        .join("")
    : empty(
        state.historyHidden
          ? "处理历史已清空显示"
          : S.status.maintenance?.cutoff
            ? "本次清理后还没有自动添加记录"
            : "还没有自动添加的记录",
        state.historyHidden
          ? "下载任务和去重依据继续保留，可点击恢复显示找回记录。"
          : "现有发布已记录为基线，新发布符合偏好时会自动添加。如需已有集数，可以使用补下载。",
        "clock",
      );
}

function renderQb(previousTorrents) {
  if (!S.qb) return;
  const q = S.qb;
  text(
    "qb-mini-status",
    q.connected
      ? "qBittorrent " + q.version + " · 已连接"
      : "qBittorrent · 未连接",
  );
  $("qb-connection").className = "notice" + (q.connected ? "" : " error");
  text(
    "qb-connection",
    q.connected
      ? `已连接 qBittorrent ${q.version} · 默认下载位置：${q.savePath || "使用下载器默认设置"}`
      : q.error + " 请在偏好设置中检查连接。",
  );
  text("connection-badge", q.connected ? "连接正常" : "未连接");
  $("connection-badge").className =
    "badge " + (q.connected ? "success" : "error");
  text(
    "default-path-hint",
    q.connected
      ? "当前默认目录：" + (q.savePath || "由下载器决定")
      : "留空即可沿用 qBittorrent 当前默认下载目录。",
  );
  const stateLabel = (s) =>
    ({
      downloading: "下载中",
      stalledDL: "等待做种",
      metaDL: "获取资源信息",
      forcedDL: "下载中",
      uploading: "做种中",
      stalledUP: "下载完成",
      stoppedDL: "已暂停",
      stoppedUP: "下载完成",
      pausedDL: "已暂停",
      pausedUP: "下载完成",
      queuedDL: "排队中",
      checkingResumeData: "正在检查",
      checkingDL: "正在检查",
      error: "任务出错",
      missingFiles: "文件缺失",
    })[s] || s;
  const cards = $("download-cards");
  cards.innerHTML = q.torrents.length
    ? q.torrents
        .map((t) => {
          const progress = Math.min(1, Math.max(0, Number(t.progress) || 0));
          const percent = (progress * 100).toFixed(1);
          const hash = escape(t.hash);
          const name = escape(t.name);
          return `<div class="download-card" data-qb-hash="${hash}">
            <div class="download-top"><span class="download-name" title="${name}">${name}</span><span class="badge ${t.progress >= 1 ? "success" : ""}">${escape(stateLabel(t.state))}</span></div>
            <div class="progress-track" role="progressbar" aria-label="${name}下载进度" aria-valuenow="${percent}"><div class="progress-fill" style="--download-progress:${progress}"></div></div>
            <div class="download-meta"><span>${percent}% · ${bytes(t.size)}</span><span>${t.downloadSpeed ? bytes(t.downloadSpeed) + "/s" : "暂无下载速度"}</span></div>
            <p class="download-location" title="${escape(t.savePath)}">下载目录：${escape(t.savePath || "由 qBittorrent 决定")}</p>
            <div class="download-shortcuts"><button type="button" class="button secondary" data-qb-folder="${hash}">打开保存目录</button><button type="button" class="button secondary" data-qb-details="${hash}">快捷操作 / 文件状态</button></div>
          </div>`;
        })
        .join("")
    : empty(
        "下一集，准备就绪",
        "符合偏好的新资源添加到 qBittorrent 后，会在这里显示进度。已有的其他下载任务不会混入。",
        "download",
      );
  window.AniBTMotion?.downloadProgress(cards, previousTorrents);
}

async function loadStatus() {
  if (statusPromise) return statusPromise;
  statusPromise = readStatus().finally(() => (statusPromise = null));
  return statusPromise;
}

async function readStatus() {
  const previous = S.status?.revision;
  S.status = await api("status");
  if (!S.themeSaving && S.status.preferences)
    window.AniBTTheme.applyPreferences(S.status.preferences);
  renderStatus();
  window.AniBTOperations?.update(S.status);
  window.AniBTQueue?.update(S.status);
  renderNotifications();
  window.AniBTHistory?.update();
  window.AniBTMaintenance?.update();
  if (
    !S.settingsInitialized ||
    (!S.formDirty && previous !== S.status.revision)
  )
    fillSettings();
  if (S.status.configurationError)
    showError(S.status.configurationError + " 请到偏好设置完成配置。");
  await window.AniBTSession?.init();
}

async function loadQb(force = false) {
  if (qbLoadPromise) {
    if (force && !qbLoadForced)
      return qbLoadPromise.catch(() => {}).then(() => loadQb(true));
    return qbLoadPromise;
  }
  qbLoadForced = force;
  qbLoadPromise = (async () => {
    const previousTorrents = S.qb?.torrents ?? [];
    S.qb = await api("qb" + (force ? "?refresh=1" : ""));
    renderQb(previousTorrents);
  })().finally(() => (qbLoadPromise = null));
  return qbLoadPromise;
}

async function loadLogs() {
  try {
    const logs = await api("logs");
    text(
      "log-output",
      [
        ...logs.lines,
        ...(logs.errors.length ? ["—— 连接与重试提示 ——", ...logs.errors] : []),
        ...(S.status?.events.length
          ? [
              "—— 界面操作记录 ——",
              ...S.status.events
                .slice(0, 12)
                .reverse()
                .map((e) => date(e.time) + "  " + e.message),
            ]
          : []),
      ].join("\n") || "后台暂时还没有日志。",
    );
  } catch (e) {
    text("log-output", e.message);
  }
}

function renderNotifications() {
  const n = S.status?.notifications || { items: [], unread: 0 };
  text("notification-count", n.unread > 99 ? "99+" : n.unread);
  $("notification-count").classList.toggle("hidden", !n.unread);
  $("notifications-button").setAttribute(
    "aria-label",
    n.unread ? `通知记录，${n.unread} 条未读` : "通知记录",
  );
  $("notifications-list").innerHTML = n.items.length
    ? n.items
        .map(
          (item) =>
            `<article class="notification-entry ${item.read ? "" : "unread"}"><span class="notification-mark">${icon("check")}</span><div><strong>${escape(item.kind === "alert" ? item.title : "下载完成")}</strong><p>${escape(item.kind === "alert" ? item.detail : item.title)}</p><small>${date(item.at)}${item.delivered ? "" : " · 已保存，系统横幅尚未确认送达"}</small></div>${item.read ? '<span class="badge">已读</span>' : `<button class="text-button" data-read-notification="${escape(item.id)}">标为已读</button>`}</article>`,
        )
        .join("")
    : empty(
        "通知会为你留在这里",
        "横幅收起后，也可以回来查看下载完成的记录。",
        "bell",
      );
  $("notifications-read-all").disabled = !n.unread;
  try {
    window.chrome?.webview?.postMessage({ type: "unread", count: n.unread });
  } catch {}
}

async function markNotificationIds(ids) {
  const n = await api("notifications/read", { ids });
  S.status.notifications = n;
  renderNotifications();
}
