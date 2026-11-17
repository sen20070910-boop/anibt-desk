"use strict";
(() => {
  const snapshotSection = document.createElement("section");
  snapshotSection.innerHTML =
    '<h3>本机完整状态快照</h3><p class="muted">包含配置、完整下载账本和待重试队列，使用 Windows 账户加密，仅用于当前安装目录。恢复会暂停后台与队列；不恢复登录资料、视频或 qB 任务。</p><div class="watched-filter-tools"><button type="button" class="button secondary" id="local-snapshot-create">创建本机快照</button><button type="button" class="button secondary" id="local-snapshot-list">查看快照</button></div><div id="local-snapshot-results"></div>';
  $("library-tools-dialog").querySelector("section").after(snapshotSection);
  async function showSnapshots() {
    const data = await api("library/snapshots");
    $("local-snapshot-results").replaceChildren(
      ...data.items.map((row) => {
        const p = document.createElement("p"),
          b = document.createElement("button");
        p.textContent =
          new Date(row.at).toLocaleString() +
          " · " +
          Math.ceil(row.bytes / 1024) +
          " KB ";
        b.type = "button";
        b.className = "text-button";
        b.textContent = "预览恢复";
        b.addEventListener(
          "click",
          () =>
            void run(b, async () => {
              const preview = await api("library/snapshot/preview", {
                id: row.id,
              });
              if (
                !confirm(
                  "恢复 " +
                    new Date(preview.at).toLocaleString() +
                    " 的本机状态？\n下载记录 " +
                    preview.done +
                    " 条，待处理 " +
                    preview.pending +
                    " 条，观看资料 " +
                    preview.tracking +
                    " 部。\n将替换当前配置和账本，后台与待处理队列会暂停。不会更改 qB 任务、视频或登录资料。",
                )
              )
                return;
              await api("library/snapshot/restore", {
                id: row.id,
                confirm: true,
              });
              await loadStatus();
              toast("本机状态已恢复；核对队列后再启用后台。");
            }),
        );
        p.append(b);
        return p;
      }),
    );
    if (!data.items.length)
      $("local-snapshot-results").textContent = "暂无本机快照。";
  }
  $("local-snapshot-create").addEventListener(
    "click",
    () =>
      void run($("local-snapshot-create"), async () => {
        await api("library/snapshot/create", {});
        await showSnapshots();
        toast("已创建加密的本机完整状态快照。");
      }),
  );
  $("local-snapshot-list").addEventListener(
    "click",
    () => void run($("local-snapshot-list"), showSnapshots),
  );
  let diagnostics = null,
    rewatch = null,
    gapAudit = null,
    gapResults = [],
    gapSelected = new Set(),
    gapBusy = false;
  let lastNotice = "";
  function continuityHint(c) {
    text(
      "offline-gap-open",
      c.needsCheck ? "离线漏集核对 · 有提醒" : "离线漏集核对",
    );
    let badge = $("offline-nav-badge");
    if (!badge) {
      badge = document.createElement("b");
      badge.id = "offline-nav-badge";
      badge.textContent = "核对";
      document.querySelector('[data-page="progress"]')?.append(badge);
    }
    badge.classList.toggle("hidden", !c.needsCheck);
    if (c.needsCheck && lastNotice !== c.detectedAt) {
      lastNotice = c.detectedAt;
      toast(
        "检测到较长时间未同步，可在追番进度核对漏集；不会自动补下载。",
        true,
      );
    }
  }
  const saveFile = (name, value) => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  async function run(button, fn, errorId = "library-tools-error") {
    button.disabled = true;
    $(errorId).classList.add("hidden");
    try {
      await fn();
    } catch (e) {
      text(errorId, e.message);
      $(errorId).classList.remove("hidden");
    } finally {
      button.disabled = false;
    }
  }
  async function status() {
    const s = await api("library/status");
    $("automatic-backup-enabled").checked = s.backup.enabled;
    $("automatic-backup-keep").value = String(s.backup.keep);
    text(
      "automatic-backup-status",
      (s.backup.lastAt
        ? "最近成功：" + date(s.backup.lastAt)
        : "尚无成功的自动备份") +
        (s.backup.lastError ? " · " + s.backup.lastError : ""),
    );
    text("library-version-status", "当前版本 v" + s.version);
    $("library-update-repository").value = s.repository;
    $("automatic-backup-list").innerHTML = s.backups.length
      ? s.backups
          .map(
            (b) =>
              `<div class="backup-list-row"><span>${escape(date(b.at))} · ${bytes(b.size)}</span><button type="button" class="text-button" data-backup-export="${escape(b.id)}">导出</button><button type="button" class="text-button" data-backup-restore="${escape(b.id)}">预览恢复</button></div>`,
          )
          .join("")
      : '<p class="muted">还没有自动备份，可点击立即备份。</p>';
    continuityHint(s.continuity);
    text(
      "offline-gap-hint",
      s.continuity.needsCheck
        ? "检测到两次成功同步相隔约 " +
            s.continuity.gapHours +
            " 小时，建议核对；未自动补下载。"
        : "可主动核对在追番剧。仅依据当前公开 RSS 与本机记录，不保证找回所有离线期间发布。",
    );
    return s;
  }
  $("library-tools-open").addEventListener("click", () => {
    $("library-tools-dialog").showModal();
    void run($("library-tools-open"), status);
  });
  $("automatic-backup-settings").addEventListener(
    "click",
    () =>
      void run($("automatic-backup-settings"), async () => {
        await api("library/backup/settings", {
          enabled: $("automatic-backup-enabled").checked,
          keep: Number($("automatic-backup-keep").value),
        });
        await status();
        toast("自动备份设置已保存。");
      }),
  );
  $("automatic-backup-now").addEventListener(
    "click",
    () =>
      void run($("automatic-backup-now"), async () => {
        const result = await api("library/backup", {});
        await status();
        toast(result.ran ? "备份已创建。" : "另一进程正在备份，请稍后刷新。");
      }),
  );
  $("automatic-backup-list").addEventListener("click", (e) => {
    const out = e.target.closest("[data-backup-export]"),
      restore = e.target.closest("[data-backup-restore]"),
      button = out || restore;
    if (!button) return;
    void run(button, async () => {
      const id = out?.dataset.backupExport || restore.dataset.backupRestore,
        data = await api("library/backup?" + new URLSearchParams({ id }));
      if (out) saveFile("AniBT-" + id, data);
      else
        await window.AniBTWorkbench.previewBackup(data, { viewingOnly: true });
    });
  });
  $("library-update-source-save").addEventListener(
    "click",
    () =>
      void run($("library-update-source-save"), async () => {
        await api("library/update-source", {
          repository: $("library-update-repository").value.trim(),
        });
        toast("更新来源已保存。");
      }),
  );
  $("library-update-check").addEventListener(
    "click",
    () =>
      void run($("library-update-check"), async () => {
        text("library-update-result", "正在检查…");
        const r = await api("library/check-update", {});
        $("library-update-result").innerHTML = !r.configured
          ? "尚未配置线上发布仓库，当前无法判断最新版。"
          : `<p>${r.newer ? "发现新版 v" + escape(r.latestVersion) : "已配置仓库的最新稳定版本为 v" + escape(r.latestVersion) + "，当前无需升级。"}</p><a href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">查看发布页 ↗</a><pre class="release-notes">${escape(r.notes)}</pre>`;
      }),
  );
  $("library-diagnostics-preview").addEventListener(
    "click",
    () =>
      void run($("library-diagnostics-preview"), async () => {
        diagnostics = await api("library/diagnostics");
        $("library-diagnostics-result").textContent = JSON.stringify(
          diagnostics,
          null,
          2,
        );
        $("library-diagnostics-export").disabled = false;
      }),
  );
  $("library-diagnostics-export").addEventListener("click", () => {
    if (diagnostics) saveFile("AniBT-diagnostics.json", diagnostics);
  });
  $("rewatch-confirm").addEventListener("click", async () => {
    if (!rewatch) return;
    const dialog = $("rewatch-confirm-dialog");
    dialog.dataset.busy = "1";
    for (const b of dialog.querySelectorAll("button")) b.disabled = true;
    try {
      await api("progress/rewatch", {
        key: rewatch.key,
        completedAt: rewatch.completedAt,
        reviewVersion: rewatch.version,
        confirm: true,
      });
      dialog.close();
      await window.AniBTWatched.refresh();
      await loadFeed();
      await window.AniBTWorkbench.load();
      toast("已开始新一轮观看；历次评分与评价保留，不会直接补下载。");
    } catch (e) {
      text("rewatch-confirm-error", e.message);
    } finally {
      delete dialog.dataset.busy;
      for (const b of dialog.querySelectorAll("button")) b.disabled = false;
    }
  });
  function renderGaps() {
    text(
      "offline-gap-status",
      `已核对 ${gapAudit?.nextOffset || 0} / ${gapAudit?.total || 0} 部 · 已选择 ${gapSelected.size} 项（每批最多 50 项）`,
    );
    $("offline-gap-results").innerHTML = gapResults
      .map(
        (group) =>
          `<section class="gap-audit-group"><h3>${escape(group.title)}</h3><p class="muted">${escape(group.error || "读取 " + group.readCount + " 条，发现 " + group.items.length + " 个可补候选" + (group.possiblyLimited ? "；本次可能未覆盖全部历史" : ""))}</p>${group.items.map((item) => `<label class="gap-audit-item"><input type="checkbox" data-gap-result="${escape(item.resultId)}" ${gapSelected.has(item.resultId) ? "checked" : ""}><span>${escape(item.title)}<small>第 ${escape(item.episode)} 集 · ${escape(item.groupName || "发布组未标注")}</small></span></label>`).join("")}</section>`,
      )
      .join("");
    $("offline-gap-review").disabled =
      gapBusy || !gapSelected.size || gapSelected.size > 50;
    $("offline-gap-next").disabled = gapBusy || !!gapAudit?.done;
    $("offline-gap-next").textContent = gapBusy
      ? "正在核对，请稍候…"
      : gapAudit
        ? "继续核对下一批"
        : "开始核对";
  }
  $("offline-gap-open").addEventListener("click", () => {
    $("offline-gap-dialog").showModal();
    void status().catch(() => {});
    renderGaps();
  });
  $("offline-gap-next").addEventListener("click", async () => {
    if (gapBusy) return;
    gapBusy = true;
    renderGaps();
    try {
      const result = await api(
        "library/gaps/check",
        gapAudit
          ? { auditId: gapAudit.auditId, offset: gapAudit.nextOffset }
          : {},
      );
      gapAudit = result;
      gapResults.push(...result.results);
    } catch (e) {
      text("offline-gap-hint", e.message);
    } finally {
      gapBusy = false;
      renderGaps();
    }
  });
  $("offline-gap-reset").addEventListener("click", () => {
    if (gapBusy) return;
    gapAudit = null;
    gapResults = [];
    gapSelected.clear();
    renderGaps();
  });
  $("offline-gap-results").addEventListener("change", (e) => {
    const checkbox = e.target.closest("[data-gap-result]");
    if (!checkbox) return;
    checkbox.checked
      ? gapSelected.add(checkbox.dataset.gapResult)
      : gapSelected.delete(checkbox.dataset.gapResult);
    renderGaps();
  });
  $("offline-gap-review").addEventListener("click", () => {
    const rows = gapResults
      .flatMap((g) => g.items)
      .filter((i) => gapSelected.has(i.resultId));
    $("offline-gap-confirm-list").innerHTML = rows
      .map((i) => `<p>${escape(i.title)}</p>`)
      .join("");
    text("offline-gap-confirm-error", "");
    $("offline-gap-confirm").showModal();
  });
  $("offline-gap-submit").addEventListener("click", async () => {
    const dialog = $("offline-gap-confirm");
    dialog.dataset.busy = "1";
    for (const b of dialog.querySelectorAll("button")) b.disabled = true;
    try {
      const result = await api("anime/resources/add", {
        confirm: true,
        selectedIds: [...gapSelected],
        mode: "normal",
        paused: S.status.config.qb.paused,
      });
      const ok = new Set(result.results.filter((r) => r.ok).map((r) => r.id));
      for (const group of gapResults)
        for (const item of group.items)
          if (ok.has(item.id)) gapSelected.delete(item.resultId);
      for (const group of gapResults)
        group.items = group.items.filter((item) => !ok.has(item.id));
      text(
        "offline-gap-confirm-error",
        "成功 " +
          ok.size +
          " 项；失败 " +
          result.results.filter((r) => !r.ok).length +
          " 项。",
      );
      await loadStatus();
      await loadFeed();
      renderGaps();
      if (result.results.every((r) => r.ok)) {
        dialog.close();
        toast("所选漏集已提交下载，成功 " + ok.size + " 项。");
      }
    } catch (e) {
      text(
        "offline-gap-confirm-error",
        e.message + " 请重新核对或在已有资源中手动选择。",
      );
    } finally {
      delete dialog.dataset.busy;
      for (const b of dialog.querySelectorAll("button")) b.disabled = false;
    }
  });
  $("offline-gap-ack").addEventListener(
    "click",
    () =>
      void run(
        $("offline-gap-ack"),
        async () => {
          await api("library/gaps/ack", {});
          await status();
          toast("离线核对提醒已清除。");
        },
        "offline-gap-hint",
      ),
  );
  for (const id of ["rewatch-confirm-dialog", "offline-gap-confirm"])
    $(id).addEventListener("cancel", (e) => {
      if ($(id).dataset.busy) e.preventDefault();
    });
  window.AniBTLibraryTools = {
    refresh: status,
    rewatch: async (show) => {
      const r = await api(
        "progress/review?" + new URLSearchParams({ key: show.key }),
      );
      rewatch = r;
      text("rewatch-confirm-title", show.title);
      text("rewatch-confirm-error", "");
      $("rewatch-confirm-dialog").showModal();
    },
  };
  window.AniBTRuntime.register(
    "continuity",
    () => api("library/status").then((s) => continuityHint(s.continuity)),
    { intervalMs: 60000 },
  );
})();
