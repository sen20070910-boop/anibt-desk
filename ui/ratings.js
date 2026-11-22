"use strict";

(() => {
  const labels = {
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
    source: "bangumi",
    page: 1,
    request: 0,
    items: [],
    loaded: false,
  };
  const dialog = $("ratings-dialog");
  const ready = new Map();
  const formatter = new Intl.NumberFormat("zh-CN");
  let activeWork,
    lookupRequest = 0;

  function score(row) {
    return row.score == null
      ? "暂无评分"
      : formatter.format(row.score) + " / " + row.scale;
  }
  function votes(row) {
    return row.votes ? formatter.format(row.votes) + " 人评分" : "";
  }
  function renderRankingRow(row, index) {
    const poster = /^\/covers\/[a-f0-9]{32}$/.test(row.cover)
      ? '<img class="ranking-poster" src="' +
        escape(row.cover) +
        '" alt="" loading="lazy" decoding="async">'
      : '<span class="ranking-poster ranking-poster-empty" aria-hidden="true">' +
        icon("library") +
        "</span>";
    return (
      '<article class="panel ranking-card rank-' +
      Math.min(row.rank, 4) +
      '">' +
      poster +
      '<div class="ranking-body"><div class="ranking-meta"><span class="ranking-position">' +
      escape(row.rank) +
      "</span><span>" +
      escape(
        [
          row.year,
          { movie: "剧场版", tv: "剧集", special: "特别篇" }[row.format],
        ]
          .filter(Boolean)
          .join(" · "),
      ) +
      "</span></div><h3>" +
      escape(row.title) +
      '</h3><div class="ranking-meta"><strong class="ranking-score">' +
      escape(score(row)) +
      "</strong><span>" +
      escape(votes(row)) +
      "</span></div>" +
      '<div class="ranking-actions"><button class="button secondary" data-ranking-find="' +
      index +
      '">' +
      icon("search") +
      '找资源</button><button class="text-button" data-ranking-lookup="' +
      index +
      '">查看评分</button></div></div></article>'
    );
  }
  async function loadRanking(refresh = false) {
    const { source, page } = ranking;
    const category = $("rankings-category").value;
    const request = ++ranking.request;
    text(
      "rankings-scope",
      source === "douban" && category === "movie"
        ? "豆瓣 · 动画电影评分榜"
        : scopes[source],
    );
    $("rankings-category").classList.toggle("hidden", source !== "douban");
    const status = $("rankings-status");
    status.textContent = "正在读取 " + labels[source] + " 榜单…";
    status.className = "notice";
    $("rankings-results").replaceChildren();
    $("rankings-pager").classList.add("hidden");
    $("rankings-refresh").disabled = true;
    ranking.loaded = true;
    try {
      const params = new URLSearchParams({
        source,
        page,
        refresh: refresh ? "1" : "0",
      });
      if (source === "douban") params.set("category", category);
      const result = await api("ratings/ranking?" + params);
      if (request !== ranking.request) return;
      ranking.items = result.items;
      status.textContent = result.items.length ? "" : "这个范围暂无榜单条目。";
      status.className = result.items.length ? "hidden" : "notice";
      $("rankings-results").innerHTML = result.items
        .map(renderRankingRow)
        .join("");
      $("rankings-prev").disabled = page <= 1;
      $("rankings-next").disabled = !result.hasNext;
      text("rankings-page", "第 " + page + " 页");
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
      result.state === "unavailable" ? "暂时无法读取" : "未匹配到对应作品";
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
          (row.votes
            ? '<small class="muted">' + escape(votes(row)) + "</small>"
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
    text("ratings-dialog-title", work.title);
    $("ratings-retry").disabled = false;
    if (!dialog.open) dialog.showModal();
    void loadRatings(work);
  }

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
  for (const [id, delta] of [
    ["rankings-prev", -1],
    ["rankings-next", 1],
  ]) {
    $(id).addEventListener("click", () => {
      ranking.page += delta;
      window.scrollTo({ top: 0, behavior: "instant" });
      void loadRanking();
    });
  }
  $("rankings-refresh").addEventListener("click", () => void loadRanking(true));
  $("rankings-category").addEventListener("change", () => {
    ranking.page = 1;
    void loadRanking();
  });
  $("rankings-results").addEventListener(
    "click",
    guarded(async (event) => {
      const find = event.target.closest("[data-ranking-find]");
      if (find) {
        const row = ranking.items[Number(find.dataset.rankingFind)];
        if (row) await window.AniBTDiscover.find(row.title);
        return;
      }
      const item = event.target.closest("[data-ranking-lookup]");
      const row = item && ranking.items[Number(item.dataset.rankingLookup)];
      if (row)
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
  });
  window.AniBTRatings = {
    enter: () => {
      if (!ranking.loaded) void loadRanking();
    },
    refresh: () => loadRanking(true),
    open,
    summary,
  };
})();
