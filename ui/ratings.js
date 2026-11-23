"use strict";

(() => {
  const labels = {
    combined: "综合排行",
    bangumi: "Bangumi",
    mal: "MyAnimeList",
    anilist: "AniList",
    douban: "豆瓣",
  };
  const scopes = {
    bangumi: "番组计划 · 动画评分榜",
    mal: "MyAnimeList · 综合动画榜",
    anilist: "AniList · 动画平均评分榜",
    douban: "豆瓣 · 日本动画剧集评分榜",
  };
  const ranking = {
    source: "combined",
    page: 1,
    request: 0,
    items: [],
    loaded: false,
  };
  const search = { request: 0, input: null, items: [] };
  const dialog = $("ratings-dialog");
  const pageTrigger = $("rankings-page");
  const pageOptions = $("rankings-page-options");
  const ready = new Map();
  const formatter = new Intl.NumberFormat("zh-CN");
  let activeWork,
    activeCombined,
    lookupRequest = 0;
  const watchRequests = new WeakMap();

  function watchWork(row) {
    const ids = {};
    if (row.bgmId) ids.bangumi = row.bgmId;
    for (const rating of row.results ? row.results.flatMap(result => result.rating ? [result.rating] : []) : [row]) {
      if (rating.source && rating.id) ids[rating.source] = rating.id;
      if (rating.malId) ids.mal ||= rating.malId;
    }
    if (!Object.keys(ids).length) return null;
    const names = [...new Set([...(row.names || []), row.originalTitle, ...(row.titleAliases || [])])]
      .filter(name => name && name !== row.title && name.length <= 100).slice(0, 6);
    return { title: row.title, names, ids, year: row.year, format: row.format };
  }

  function watchBadge(status) {
    return status?.watched
      ? '<span class="badge success">已看</span>' + (status.score == null ? "" :
        '<span>我的评分 ' + escape(formatter.format(status.score)) + ' / 10</span>')
      : "";
  }

  function watchButton(row, index) {
    return watchWork(row) ? '<button type="button" class="text-button" data-rating-watch="' +
      index + '">' + (row.watch?.watched ? "我的评分" : "标为已看并评分") + '</button>' : "";
  }

  function paintWatch(row, button, status) {
    row.watch = status;
    button.textContent = status?.watched ? "我的评分" : "标为已看并评分";
    button.closest("article").querySelector("[data-rating-watch-status]").innerHTML = watchBadge(status);
  }

  async function syncWatches(rows, container) {
    const request = {};
    watchRequests.set(container, request);
    const entries = [...container.querySelectorAll("[data-rating-watch]")].flatMap(button => {
      const row = rows[Number(button.dataset.ratingWatch)];
      return row && button.isConnected ? [{ row, input: watchWork(row), button }] : [];
    });
    for (let offset = 0; offset < entries.length; offset += 20) {
      if (watchRequests.get(container) !== request) return;
      const batch = entries.slice(offset, offset + 20);
      try {
        const result = await api("ratings/watched/status", { works: batch.map(entry => entry.input) });
        if (watchRequests.get(container) !== request) return;
        batch.forEach(({ row, button }, index) => {
          if (button.isConnected) paintWatch(row, button, result.items[index]);
        });
      } catch { return; }
    }
  }

  async function openWatch(button, row, container) {
    const input = row && watchWork(row);
    if (!input) return;
    button.disabled = true;
    watchRequests.delete(container);
    try {
      const result = await api("ratings/watched", input);
      if (button.isConnected) paintWatch(row, button, result);
      void syncWatches(ranking.items, $("rankings-results"));
      void syncWatches(search.items, $("ratings-search-results"));
      await window.AniBTReviews.open({ key: result.key, title: row.title }, { edit: true });
    } finally {
      button.disabled = false;
    }
  }

  function score(row) {
    return row.score == null
      ? "暂无评分"
      : formatter.format(row.score) + " / " + row.scale;
  }
  function votes(row) {
    return row.votes ? formatter.format(row.votes) + " 人评分" : "";
  }
  function poster(image = "") {
    return (
      '<span class="ranking-poster ranking-poster-empty ratings-poster" aria-hidden="true">' +
      icon("library") +
      image +
      "</span>"
    );
  }
  function togglePageOptions(visible) {
    pageOptions.classList.toggle("hidden", !visible);
    pageTrigger.setAttribute("aria-expanded", String(visible));
    if (visible)
      pageOptions
        .querySelector('[aria-current="page"]')
        ?.focus({ preventScroll: true });
  }
  function renderPageOptions(page, totalPages) {
    pageTrigger.textContent = "第 " + page + " 页";
    pageOptions.replaceChildren(
      ...Array.from({ length: totalPages }, (_, index) => {
        const number = index + 1;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.rankingPage = number;
        button.textContent = number;
        button.setAttribute("aria-label", "第 " + number + " 页");
        if (number === page) button.setAttribute("aria-current", "page");
        return button;
      }),
    );
  }
  function renderRankingRow(row, index) {
    const combined = Array.isArray(row.results);
    const rank = row.rank
      ? '<span class="ranking-position">' + escape(row.rank) + "</span>"
      : "";
    const metadata = combined
      ? (row.rank ? "本榜前 " + row.topPercent + "% · " : "数据较少 · ") +
        row.coverage +
        "/4 站" +
        (row.supplemental ? " · 两站补位" : "") +
        (row.disagreement ? " · 站间分歧" : "")
      : votes(row);
    const image = /^\/covers\/[a-f0-9]{32}$/.test(row.cover)
      ? '<img class="ranking-poster" src="' +
        escape(row.cover) +
        '" alt="" loading="lazy" decoding="async">'
      : "";
    return (
      '<article class="panel ranking-card rank-' +
      Math.min(row.rank, 4) +
      '">' +
      poster(image) +
      '<div class="ranking-body"><div class="ranking-meta">' +
      rank +
      "<span>" +
      escape(
        [
          row.year,
          { movie: "剧场版", tv: "剧集", special: "特别篇" }[row.format],
        ]
          .filter(Boolean)
          .join(" · "),
      ) +
      "</span><span class=\"rating-watch-status\" data-rating-watch-status>" +
      watchBadge(row.watch) +
      "</span></div><h3>" +
      escape(row.title) +
      '</h3><div class="ranking-meta"><strong class="ranking-score">' +
      escape(
        combined ? formatter.format(row.index) + " 综合指数" : score(row),
      ) +
      "</strong><span>" +
      escape(metadata) +
      "</span></div>" +
      '<div class="ranking-actions"><button class="button secondary" data-ranking-find="' +
      index +
      '">' +
      icon("search") +
      '找资源</button><button class="text-button" data-ranking-lookup="' +
      index +
      '">查看评分</button>' + watchButton(row, index) + '</div></div></article>'
    );
  }
  async function loadRanking(refresh = false) {
    const { source, page } = ranking;
    const combined = source === "combined",
      limited = combined && $("rankings-limited").checked;
    const category = $("rankings-category").value;
    const request = ++ranking.request;
    text(
      "rankings-scope",
      combined
        ? "四站口碑 · " + (category === "movie" ? "动画电影" : "电视动画剧集")
        : source === "douban" && category === "movie"
          ? "豆瓣 · 动画电影评分榜"
          : scopes[source],
    );
    $("rankings-category").classList.toggle(
      "hidden",
      !combined && source !== "douban",
    );
    $("rankings-limited-control").classList.toggle("hidden", !combined);
    $("rankings-method").classList.add("hidden");
    const status = $("rankings-status");
    status.textContent = combined
      ? "正在读取四站样本并计算综合排行…"
      : "正在读取 " + labels[source] + " 榜单…";
    status.className = "notice";
    if (!refresh) $("rankings-results").replaceChildren();
    togglePageOptions(false);
    $("rankings-pager").classList.add("hidden");
    $("rankings-refresh").disabled = true;
    ranking.loaded = true;
    try {
      const params = new URLSearchParams({
        source,
        page,
        refresh: refresh ? "1" : "0",
      });
      if (combined || source === "douban") params.set("category", category);
      if (limited) params.set("view", "limited");
      const result = await api("ratings/ranking?" + params);
      if (request !== ranking.request) return;
      if (result.totalPages && page > result.totalPages) {
        ranking.page = result.totalPages;
        return loadRanking();
      }
      ranking.items = result.items;
      status.textContent = result.items.length ? "" : "这个范围暂无榜单条目。";
      status.className = result.items.length ? "hidden" : "notice";
      if (combined)
        renderCoverage(result.metadata, status, limited, result.items.length);
      $("rankings-results").innerHTML = result.items
        .map(renderRankingRow)
        .join("");
      void syncWatches(ranking.items, $("rankings-results"));
      $("rankings-prev").disabled = page <= 1;
      $("rankings-next").disabled = !result.hasNext;
      const totalPages = result.totalPages || (result.hasNext ? 20 : page);
      renderPageOptions(page, totalPages);
      $("rankings-pager").classList.toggle(
        "hidden",
        page === 1 && !result.hasNext,
      );
    } catch (error) {
      if (request !== ranking.request) return;
      status.className = "notice warning";
      status.textContent =
        labels[source] +
        " 榜单读取失败。" +
        error.message +
        " 可刷新榜单或切换来源。";
    } finally {
      if (request === ranking.request) $("rankings-refresh").disabled = false;
    }
  }

  function renderCoverage(metadata, status, limited, itemCount) {
    const sample = Object.entries(metadata.referenceCounts)
      .map(
        ([source, count]) =>
          labels[source] + " " + formatter.format(count) + " 部",
      )
      .join("、");
    const date = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(metadata.updatedAt);
    text(
      "rankings-coverage",
      "正式上榜 " +
        metadata.ranked +
        " 部 · 数据较少 " +
        metadata.limited +
        " 部 · 更新于 " +
        date +
        "。" +
        "其中 " + Math.min(metadata.eligible, metadata.ranked) + " 部有三站以上评分" +
        (metadata.supplemental ? "，" + metadata.supplemental + " 部为两站补位。" : "。") +
        "参考样本 " +
        sample +
        "。",
    );
    const { count, checks } = metadata.stability;
    const comparison = count === metadata.eligible ? Math.min(10, count) : count;
    text(
      "rankings-stability",
      count
        ? "仅比较三站以上的作品。逐站去除后，仍留在前 " +
            comparison +
            " 名的作品数 · " +
            checks
              .map(
                (check) =>
                  labels[check.source] +
                  " " +
                  (comparison === count
                    ? check.retained
                    : check.topTenRetained) +
                  "/" +
                  comparison,
              )
              .join("、") +
            "。前 " +
            count +
            " 名中最大位移 " +
            Math.max(...checks.map((check) => check.largestShift)) +
            " 位。"
        : "有三站以上评分的作品上榜后可查看排名稳定性。",
    );
    $("rankings-method").classList.remove("hidden");
    const messages = [];
    if (metadata.stale) messages.push("刷新结果不完整，暂时显示上次榜单。");
    else if (metadata.partial)
      messages.push("部分站点或样本暂不可用，当前榜单按已取得的数据计算。");
    if (!limited && metadata.ranked > 0 && metadata.ranked < metadata.target)
      messages.push("当前有 " + metadata.ranked + " 部作品匹配到至少两站评分，目标 " + metadata.target + " 部。");
    if (!itemCount)
      messages.push(
        limited
          ? "暂无数据较少的候选作品。"
          : "当前没有同时匹配到两站评分的作品，可以查看数据较少的作品。",
      );
    if (messages.length) {
      status.textContent = messages.join(" ");
      status.className =
        metadata.partial || metadata.stale ? "notice warning" : "notice";
    }
  }

  function workKey(work) {
    return JSON.stringify([work.title, work.year, work.format, work.ids]);
  }
  function summary(work) {
    const hit = ready.get(workKey(work));
    const scored = hit?.rows.filter((row) => row.rating?.score != null) || [];
    return scored.length
      ? labels[scored[0].source] + " " + score(scored[0].rating)
      : "查看评分";
  }
  function renderRatingRow(result) {
    const row = result.rating;
    const state =
      result.state === "checking"
        ? "正在补查原站评分…"
        : result.state === "unavailable"
        ? "暂时无法读取"
        : result.snapshot
          ? "榜单样本中未匹配"
          : "未匹配到对应作品";
    return (
      '<div class="rating-provider"><div><strong>' +
      escape(labels[result.source]) +
      "</strong>" +
      (row ? '<small class="muted">' + escape(row.title) + "</small>" : "") +
      '</div><div class="rating-provider-score">' +
      (row
        ? '<strong class="ranking-score">' +
          escape(score(row)) +
          "</strong>" +
          (row.votes || result.snapshot
            ? '<small class="muted">' +
              escape(votes(row) || "人数未知") +
              "</small>"
            : "") +
          (result.supplement
            ? '<small class="muted">原站补查 · 未计入本期综合指数</small>'
            : result.snapshot
            ? '<small class="muted">' +
              escape(
                "第 " +
                  formatter.format(row.percentile) +
                  " 百分位 · " +
                  row.referenceSize +
                  " 部样本" +
                  (Math.abs(row.adjustedScore - row.score) >= 0.05
                    ? " · 校正后 " + formatter.format(row.adjustedScore)
                    : ""),
              ) +
              "</small>"
            : "")
        : '<span class="muted">' + state + "</span>") +
      "</div>" +
      (row
        ? '<a class="text-button" href="' +
          escape(row.url) +
          '" target="_blank" rel="noopener noreferrer">原站 ' +
          icon("external") +
          "</a>"
        : "") +
      "</div>"
    );
  }
  async function loadRatings(work, refresh = false) {
    const request = ++lookupRequest,
      key = workKey(work);
    const results = $("ratings-dialog-results");
    const previous = !refresh && ready.get(key);
    if (previous && previous.expires > Date.now()) {
      results.innerHTML = previous.rows.map(renderRatingRow).join("");
      return;
    }
    results.textContent = "正在查找各站评分…";
    $("ratings-retry").disabled = true;
    try {
      const params = new URLSearchParams({
        title: work.title,
        refresh: refresh ? "1" : "0",
      });
      if (work.year) params.set("year", work.year);
      if (work.format) params.set("format", work.format);
      for (const [source, id] of Object.entries(work.ids || {}))
        if (id) params.set(source, id);
      const result = await api("ratings/lookup?" + params);
      const cacheMs = result.results.some((row) => row.state === "unavailable")
        ? 60_000
        : 15 * 60_000;
      ready.delete(key);
      ready.set(key, { rows: result.results, expires: Date.now() + cacheMs });
      if (ready.size > 80) ready.delete(ready.keys().next().value);
      window.dispatchEvent(new CustomEvent("anibt-ratings-loaded"));
      if (request === lookupRequest)
        results.innerHTML = result.results.map(renderRatingRow).join("");
    } catch (error) {
      if (request === lookupRequest) results.textContent = error.message;
    } finally {
      if (request === lookupRequest) $("ratings-retry").disabled = false;
    }
  }
  function open(work) {
    if (!work.title) return;
    activeWork = work;
    activeCombined = null;
    text("ratings-dialog-title", work.displayTitle || work.title);
    $("ratings-combined-summary").classList.add("hidden");
    $("ratings-retry").classList.remove("hidden");
    $("ratings-retry").disabled = false;
    if (!dialog.open) dialog.showModal();
    void loadRatings(work);
  }
  function openCombined(row) {
    activeWork = null;
    activeCombined = row;
    text("ratings-dialog-title", row.title);
    text(
      "ratings-combined-summary",
      formatter.format(row.index) +
        " 综合指数 · " +
        row.coverage +
        "/4 站" +
        (row.rank ? " · 本榜前 " + row.topPercent + "%" : " · 数据较少") +
        (row.supplemental ? " · 两站补位" : "") +
        (row.disagreement
          ? " · 最高与最低相差 " + formatter.format(row.gap) + " 个百分位点"
          : ""),
    );
    $("ratings-combined-summary").classList.remove("hidden");
    if (!dialog.open) dialog.showModal();
    void fillCombinedDetails(row);
  }

  async function fillCombinedDetails(row, refresh = false) {
    const request = ++lookupRequest;
    const params = new URLSearchParams({
      title: row.title, year: row.year || "", format: row.format || "",
      refresh: refresh ? "1" : "0",
    });
    const missing = new Set();
    for (const result of row.results) {
      if (result.rating) params.set(result.source, result.rating.id);
      else {
        missing.add(result.source);
        params.append("source", result.source);
      }
    }
    for (const name of (row.names || []).slice(0, 12)) params.append("name", name);
    const render = (extra, loading = false) => {
      $("ratings-dialog-results").innerHTML = row.results.map((result) => {
        const match = extra.find((entry) => entry.source === result.source);
        if (match) return renderRatingRow({ ...match, supplement: true });
        const state = loading && missing.has(result.source) ? "checking" : result.state;
        return renderRatingRow({ ...result, state, snapshot: true });
      }).join("");
    };
    const retry = $("ratings-retry");
    retry.classList.toggle("hidden", !missing.size);
    retry.disabled = Boolean(missing.size);
    render([], Boolean(missing.size));
    if (!missing.size) return;
    try {
      const data = await api("ratings/lookup?" + params);
      if (request === lookupRequest && dialog.open) render(data.results);
    } catch {
      if (request === lookupRequest && dialog.open) render([]);
    } finally {
      if (request === lookupRequest) retry.disabled = false;
    }
  }

  const searchKey = (value) => norm(value).replace(/[^\p{L}\p{N}]/gu, "");
  const findNames = (row) =>
    [row.title, row.originalTitle, ...(row.titleAliases || [])].filter(Boolean);
  function openSearchItem(row) {
    open({
      title: [...new Set(findNames(row))].slice(0, 4).join(" / "),
      displayTitle: row.title,
      year: row.year,
      format: row.format,
      ids: { bangumi: row.bgmId },
    });
  }

  function searchCard(row, index) {
    const type = {
      TV: "剧集",
      TV_SHORT: "短篇剧集",
      MOVIE: "剧场版",
      SPECIAL: "特别篇",
      OVA: "OVA",
      ONA: "网络动画",
    };
    const cover = row.cover
      ? '<img class="ranking-poster" data-cover-url="' +
        escape(row.cover) +
        '" alt="" decoding="async">'
      : "";
    const original =
      row.originalTitle && row.originalTitle !== row.title
        ? row.originalTitle
        : "";
    return `<article class="panel ranking-card">
      ${poster(cover)}
      <div class="ranking-body">
        <div class="ranking-meta">${escape([row.year, type[row.format]].filter(Boolean).join(" · "))}<span class="rating-watch-status" data-rating-watch-status>${watchBadge(row.watch)}</span></div>
        <h3>${escape(row.title)}</h3>
        ${original ? `<div class="ranking-meta ratings-search-original">${escape(original)}</div>` : ""}
        <div class="ranking-actions">
          <button class="button secondary" data-rating-search-score="${index}">查看评分</button>
          <button class="text-button" data-rating-search-find="${index}">找资源</button>
          ${watchButton(row, index)}
        </div>
      </div>
    </article>`;
  }

  function showSearchView(visible) {
    if (visible) togglePageOptions(false);
    $("ratings-search-view").classList.toggle("hidden", !visible);
    $("rankings-view").classList.toggle("hidden", visible);
    $("rankings-refresh").classList.toggle("hidden", visible);
  }

  async function searchWorks(autoOpen = true) {
    const field = $("ratings-search-query");
    const query = field.value.trim();
    if (!query) {
      field.value = "";
      field.reportValidity();
      return;
    }
    const date = /\s*[(（]((?:19|20)\d{2})[)）]$/.exec(query);
    const title = date?.index ? query.slice(0, date.index).trim() : query;
    const year = date?.index ? date[1] : "";
    const request = ++search.request;
    search.input = { title, year };
    search.items = [];
    showSearchView(true);
    $("ratings-search-results").replaceChildren();
    $("ratings-search-direct").classList.add("hidden");
    text("ratings-search-status", "正在搜索「" + query + "」…");
    try {
      const result = await api(
        "anibt/catalog?" + new URLSearchParams({ q: title }),
      );
      if (request !== search.request) return;
      search.items = year
        ? result.items.filter((row) => String(row.year || "") === year)
        : result.items;
      $("ratings-search-results").innerHTML = search.items
        .map(searchCard)
        .join("");
      void syncWatches(search.items, $("ratings-search-results"));
      $("ratings-search-direct").classList.remove("hidden");
      text(
        "ratings-search-status",
        search.items.length
          ? "找到 " + search.items.length + " 部作品。可按年份和季数选择。"
          : "番剧目录未找到匹配作品，可以按输入名称直接查询四站。",
      );
      const exact = search.items.filter((row) =>
        findNames(row).some((name) => searchKey(name) === searchKey(title)),
      );
      if (autoOpen && exact.length === 1 && S.page === "rankings") openSearchItem(exact[0]);
    } catch {
      if (request !== search.request) return;
      text(
        "ratings-search-status",
        "番剧目录暂时无法读取，可以按输入名称直接查询四站。",
      );
      $("ratings-search-direct").classList.remove("hidden");
    }
  }

  $("ratings-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void searchWorks();
  });
  $("ratings-search-direct").addEventListener("click", () => {
    if (search.input) open(search.input);
  });
  $("ratings-search-back").addEventListener("click", () => {
    search.request++;
    showSearchView(false);
    $("ratings-search-query").focus();
  });
  $("ratings-search-results").addEventListener(
    "click",
    guarded(async (event) => {
      const watch = event.target.closest("[data-rating-watch]");
      if (watch) return openWatch(watch, search.items[Number(watch.dataset.ratingWatch)], $("ratings-search-results"));
      const scoreButton = event.target.closest("[data-rating-search-score]");
      const findButton = event.target.closest("[data-rating-search-find]");
      if (scoreButton)
        openSearchItem(
          search.items[Number(scoreButton.dataset.ratingSearchScore)],
        );
      if (findButton)
        await window.AniBTDiscover.find(
          search.items[Number(findButton.dataset.ratingSearchFind)].title,
        );
    }),
  );

  for (const button of document.querySelectorAll("[data-rating-source]")) {
    button.addEventListener("click", () => {
      if (ranking.source === button.dataset.ratingSource) return;
      ranking.source = button.dataset.ratingSource;
      ranking.page = 1;
      for (const tab of document.querySelectorAll("[data-rating-source]")) {
        tab.classList.toggle("selected", tab === button);
        tab.setAttribute("aria-pressed", String(tab === button));
      }
      void loadRanking();
    });
  }
  function goToRankingPage(page) {
    if (page === ranking.page) return;
    ranking.page = page;
    window.scrollTo({ top: 0, behavior: "instant" });
    void loadRanking();
  }
  for (const [id, delta] of [
    ["rankings-prev", -1],
    ["rankings-next", 1],
  ]) {
    $(id).addEventListener("click", () =>
      goToRankingPage(ranking.page + delta),
    );
  }
  const pageJump = $("rankings-page-jump");
  pageTrigger.addEventListener("click", () =>
    togglePageOptions(pageOptions.classList.contains("hidden")),
  );
  pageOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ranking-page]");
    if (!button) return;
    pageTrigger.focus({ preventScroll: true });
    togglePageOptions(false);
    goToRankingPage(Number(button.dataset.rankingPage));
  });
  pageJump.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || pageOptions.classList.contains("hidden"))
      return;
    event.preventDefault();
    pageTrigger.focus({ preventScroll: true });
    togglePageOptions(false);
  });
  pageJump.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !pageJump.contains(event.relatedTarget))
      togglePageOptions(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !pageOptions.classList.contains("hidden") &&
      !pageJump.contains(event.target)
    )
      togglePageOptions(false);
  });
  window.addEventListener("anibt-page-change", () => togglePageOptions(false));
  $("rankings-refresh").addEventListener("click", () => void loadRanking(true));
  $("rankings-results").addEventListener(
    "error",
    (event) => {
      if (event.target.matches("img.ranking-poster"))
        event.target.hidden = true;
    },
    true,
  );
  for (const id of ["rankings-category", "rankings-limited"]) {
    $(id).addEventListener("change", () => {
      ranking.page = 1;
      void loadRanking();
    });
  }
  $("rankings-results").addEventListener(
    "click",
    guarded(async (event) => {
      const watch = event.target.closest("[data-rating-watch]");
      if (watch) return openWatch(watch, ranking.items[Number(watch.dataset.ratingWatch)], $("rankings-results"));
      const find = event.target.closest("[data-ranking-find]");
      if (find) {
        const row = ranking.items[Number(find.dataset.rankingFind)];
        if (row) await window.AniBTDiscover.find(row.title);
        return;
      }
      const item = event.target.closest("[data-ranking-lookup]");
      const row = item && ranking.items[Number(item.dataset.rankingLookup)];
      if (row?.results) openCombined(row);
      else if (row)
        open({
          title: row.names.slice(0, 3).join(" / "),
          year: row.year,
          format: row.format,
          ids: { [row.source]: row.id },
        });
    }),
  );
  $("ratings-retry").addEventListener("click", () => {
    if (activeWork) void loadRatings(activeWork, true);
    else if (activeCombined) void fillCombinedDetails(activeCombined, true);
  });
  window.addEventListener("anibt-review-saved", () => {
    if (S.page !== "rankings") return;
    void syncWatches(ranking.items, $("rankings-results"));
    void syncWatches(search.items, $("ratings-search-results"));
  });
  window.AniBTRatings = {
    enter: () => {
      if (!ranking.loaded) void loadRanking();
      else {
        void syncWatches(ranking.items, $("rankings-results"));
        void syncWatches(search.items, $("ratings-search-results"));
      }
    },
    refresh: () => loadRanking(true),
    refreshCurrent: () => $("ratings-search-view").classList.contains("hidden") ? loadRanking(true) : searchWorks(false),
    open,
    summary,
  };
})();
