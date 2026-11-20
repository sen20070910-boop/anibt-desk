"use strict";
(() => {
  let target = {},
    info = null,
    request = 0;
  const folderRequests = new Map();
  function renderSubtitles(result) {
    const sidecars = result.sidecarSubtitles || [];
    const videos = result.subtitleVideos || [];
    $("history-subtitles").classList.remove("hidden");
    $("history-sidecar-subtitles").innerHTML = sidecars.length
      ? '<p class="muted">外挂字幕（按文件名）</p><ul>' +
        sidecars
          .map(
            (file) =>
              `<li>${escape(file.name)} · ${escape(file.language)}</li>`,
          )
          .join("") +
        "</ul>"
      : '<p class="muted">当前任务没有可核实的已下载外挂字幕。</p>';
    $("history-subtitle-controls").classList.toggle("hidden", !videos.length);
    $("history-subtitle-video").disabled = false;
    $("history-subtitle-video").replaceChildren(
      ...videos.map((file) => {
        const option = document.createElement("option");
        option.value = String(file.index);
        option.textContent = file.name;
        return option;
      }),
    );
    $("history-embedded-subtitles").textContent = videos.length
      ? ""
      : "有已下载完成且可在本机访问的视频时，可读取内封字幕轨。";
  }
  $("history-subtitle-video").addEventListener("change", () => {
    text("history-embedded-subtitles", "");
  });
  $("history-subtitle-read").addEventListener("click", async () => {
    const selected = $("history-subtitle-video");
    if (!selected.value) return;
    const current = request;
    const button = $("history-subtitle-read");
    const result = $("history-embedded-subtitles");
    button.disabled = true;
    selected.disabled = true;
    result.textContent = "正在读取视频字幕轨…";
    try {
      const data = await api("history/subtitles", {
        ...target,
        index: Number(selected.value),
      });
      if (current !== request || !$("history-task-dialog").open) return;
      result.innerHTML = data.tracks.length
        ? `<p>内封字幕轨 · ${escape(data.name)}</p><ul>${data.tracks
            .map(
              (track) =>
                `<li>${[track.language, track.tag, track.title, track.codec].filter(Boolean).map(escape).join(" · ")}</li>`,
            )
            .join("")}</ul>`
        : "未读到独立字幕轨。画面中的硬字幕无法通过轨道读取。";
    } catch (error) {
      if (current === request) result.textContent = error.message;
    } finally {
      if (current === request) {
        button.disabled = false;
        selected.disabled = false;
      }
    }
  });
  window.chrome?.webview?.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "folder-open-response") return;
    const pending = folderRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    folderRequests.delete(message.id);
    message.error
      ? pending.reject(new Error(message.error))
      : pending.resolve(message);
  });
  async function openFolder(target) {
    const native = !!window.chrome?.webview?.postMessage;
    const result = await api("history/open-folder", { ...target, native });
    if (!native) return;
    const id = crypto.randomUUID();
    const opened = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        folderRequests.delete(id);
        reject(new Error("资源管理器响应超时，请重试。"));
      }, 10000);
      folderRequests.set(id, { resolve, reject, timer });
      try {
        window.chrome.webview.postMessage({
          type: "folder-open",
          id,
          path: result.folderPath,
        });
      } catch (error) {
        clearTimeout(timer);
        folderRequests.delete(id);
        reject(error);
      }
    });
    if (opened.foreground === false)
      toast("目录已打开，但 Windows 未允许切到前台，请从任务栏查看。", true);
  }

  document.addEventListener(
    "click",
    guarded(async (e) => {
      const folder = e.target.closest("[data-qb-folder]");
      if (folder) {
        folder.disabled = true;
        try {
          await openFolder({ hash: folder.dataset.qbFolder });
        } finally {
          folder.disabled = false;
        }
        return;
      }
      const b = e.target.closest("[data-history-details],[data-qb-details]");
      if (!b) return;
      target = b.dataset.qbDetails
        ? { hash: b.dataset.qbDetails }
        : { key: b.dataset.historyDetails };
      const n = ++request;
      info = null;
      $("history-subtitles").classList.add("hidden");
      $("history-subtitle-read").disabled = false;
      $("history-task-body").textContent = "正在读取 qB 状态并核实文件…";
      $("history-task-folder").disabled = true;
      $("history-task-locate").disabled = true;
      $("history-task-dialog").showModal();
      try {
        const result = await api("history/task?" + new URLSearchParams(target));
        if (n !== request || !$("history-task-dialog").open) return;
        info = result;
        renderSubtitles(result);
        $("history-task-body").innerHTML =
          `<h3>${escape(result.title)}</h3><p>${result.recordedAt ? "记录时间：" + date(result.recordedAt) + "；处理记录不代表文件仍然存在。" : "处理记录已清理或尚未记录；以下读取当前 qB 任务核实。"}</p><p>曾确认下载完成：${result.historicallyCompleted ? "是" : "暂无完成记录"}</p><p>qB：${result.connected ? (result.taskPresent ? "已找到任务 · " + Math.round((result.progress || 0) * 100) + "%" : "当前未找到该任务") : "未连接"}</p><p>保存目录：${escape(result.savePath || "未记录")}</p><div class="notice ${["missing", "directory-missing", "incomplete"].includes(result.fileStatus) ? "error" : result.fileStatus === "unknown" ? "warning" : ""}">${escape(result.fileMessage)}</div><div class="history-source-links">${result.links.map((l) => `<a href="${escape(l.url)}" target="_blank" rel="noopener noreferrer">查看 ${escape(l.name)} 发布页 ↗</a>`).join("") || '<p class="muted">旧记录未保存可用的发布页地址。</p>'}</div>`;
        $("history-task-folder").disabled = !result.canOpenFolder;
        $("history-task-locate").disabled = !result.taskPresent;
        $("history-task-folder").title = result.canOpenFolder
          ? "打开保存目录并切换到前台"
          : result.savePath
            ? "目录不存在、不可访问或下载器位于远程"
            : "旧记录未保存目录，且 qB 未返回任务目录";
        $("history-task-locate").title = result.taskPresent
          ? "定位到工具内的 qB 任务列表"
          : result.connected
            ? "qB 中已没有这条任务，可使用重新处理恢复"
            : "qB 未连接，请启动后重试";
        $("history-task-body").insertAdjacentHTML(
          "beforeend",
          (!result.canOpenFolder
            ? '<p class="muted">打开目录不可用：' +
              escape($("history-task-folder").title) +
              "</p>"
            : "") +
            (!result.taskPresent
              ? '<p class="muted">定位不可用：' +
                escape($("history-task-locate").title) +
                "</p>"
              : "") +
            '<p class="muted">定位会跳转到本工具的 qB 任务列表。查看详情不会自动启动 qB；需要重新下载时，请使用记录右侧的“重新处理”。</p>',
        );
      } catch (error) {
        $("history-task-body").textContent = error.message;
      }
    }),
  );
  $("history-task-folder").addEventListener(
    "click",
    guarded(async () => {
      if (!info?.canOpenFolder) return;
      await openFolder(target);
    }),
  );
  $("history-task-locate").addEventListener(
    "click",
    guarded(async () => {
      if (!info) return;
      const hash = info.hash;
      $("history-task-dialog").close();
      changePage("downloads");
      await loadQb(true);
      const card = [...document.querySelectorAll("[data-qb-hash]")].find(
        (e) => e.dataset.qbHash.toLowerCase() === hash.toLowerCase(),
      );
      if (!card) throw new Error("任务已变化或 qB 未连接，请刷新后重试。");
      card.classList.add("task-highlight");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => card.classList.remove("task-highlight"), 4000);
    }),
  );
  $("history-task-dialog").addEventListener("close", () => ++request);
})();
