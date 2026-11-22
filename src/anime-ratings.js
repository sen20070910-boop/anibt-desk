import { load } from "cheerio/slim";
import { Converter } from "opencc-js/t2cn";
import { createSourceNetwork } from "./source-network.js";
import { bangumiNames, findBangumi, readBangumi } from "./bangumi-catalog.js";
import { createCombinedRankings } from "./combined-rankings.js";

export const RATING_SOURCES = ["bangumi", "mal", "anilist", "douban"];
const pageSize = 25;
const malPageSize = 50;
const bangumi = "https://api.bgm.tv";
const mal = "https://myanimelist.net";
const douban = "https://movie.douban.com";
const simplify = Converter({ from: "t", to: "cn" });
const clean = (value) =>
  typeof value === "string" ? value.trim().slice(0, 240) : "";
const numberId = (value) =>
  /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value) : "";
const yearOf = (value) =>
  /^(?:19|20)\d{2}/.exec(String(value ?? ""))?.[0] || "";
const getNames = (...values) => [
  ...new Set(values.flat().map(clean).filter(Boolean)),
];
const unique = (rows) => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];
const GQL_FIELDS = `id idMal title { english romaji native } synonyms
  averageScore stats { scoreDistribution { amount } }
  startDate { year } format coverImage { large }`;

function titleKey(value) {
  return simplify(clean(value).normalize("NFKC").toLowerCase())
    .replace(/\s*\((?:19|20)\d{2}\)$/u, "")
    .replace(
      /第\s*([一二三四五六七八九十\d]+)\s*[季期]/gu,
      (_, n) =>
        " season " +
        ("一二三四五六七八九十".includes(n)
          ? "一二三四五六七八九十".indexOf(n) + 1
          : n),
    )
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, "season $1")
    .replace(/\bs(\d{1,2})\b/g, "season $1")
    .replace(/\bseason\s*(\d{1,3})\b/g, (_, n) => "season " + Number(n))
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function formatKey(value) {
  const format = clean(value).toUpperCase();
  if (["MOVIE", "剧场版", "电影"].includes(format)) return "movie";
  if (["SPECIAL", "TV SPECIAL", "TV_SPECIAL"].includes(format))
    return "special";
  if (["TV", "TV_SHORT", "TV短片"].includes(format)) return "tv";
  return "";
}

function compatibleFormat(a, b) {
  return !a || !b || a === b || a === "special" || b === "special";
}

export function matchAnimeRating(rows, target) {
  const keys = getNames(target.names || [], target.title)
    .map(titleKey)
    .filter(Boolean);
  const matches = unique(rows).filter(
    (row) =>
      (!target.year || !row.year || row.year === target.year) &&
      compatibleFormat(target.format, row.format) &&
      row.names.some((value) => keys.includes(titleKey(value))),
  );
  return matches.length === 1 ? matches[0] : null;
}

function rating(source, fields) {
  const id = numberId(fields.id);
  const names = getNames(fields.names);
  if (!id || !names.length) return null;
  const scale = source === "anilist" ? 100 : 10;
  const score = Number(fields.score);
  const votes = Number(String(fields.votes ?? "").replaceAll(",", ""));
  return {
    source,
    id,
    names,
    title: names[0],
    year: yearOf(fields.year),
    format: formatKey(fields.format),
    score: score > 0 && score <= scale ? score : null,
    scale,
    votes: Number.isSafeInteger(votes) && votes > 0 ? votes : null,
    rank:
      Number.isSafeInteger(fields.rank) && fields.rank > 0 ? fields.rank : null,
    cover: clean(fields.cover),
    malId: numberId(fields.malId),
    url:
      {
        bangumi: "https://bgm.tv/subject/",
        mal: mal + "/anime/",
        anilist: "https://anilist.co/anime/",
        douban: douban + "/subject/",
      }[source] +
      id +
      (source === "douban" ? "/" : ""),
  };
}

const bangumiRow = (item) =>
  item &&
  rating("bangumi", {
    id: item.id,
    names: bangumiNames(item),
    year: item.date || item.air_date,
    format: item.platform,
    rank: item.rating?.rank || item.rank,
    score: item.rating?.score,
    votes: item.rating?.total,
    cover: item.images?.large || item.images?.common,
  });
const anilistRow = (item) =>
  rating("anilist", {
    id: item.id,
    malId: item.idMal,
    names: getNames(
      item.title?.english,
      item.title?.romaji,
      item.title?.native,
      item.synonyms || [],
    ),
    year: item.startDate?.year,
    format: item.format,
    score: item.averageScore,
    cover: item.coverImage?.large,
    votes: item.stats?.scoreDistribution?.reduce(
      (total, row) => total + (Number(row.amount) || 0),
      0,
    ),
  });

const malIdFrom = (value) =>
  /(?:^|myanimelist\.net)\/anime\/(\d+)(?:\/|$)/.exec(value ?? "")?.[1];

export function parseMalRanking(html) {
  const $ = load(html);
  if (!$("tr.ranking-list").length) throw Error("MyAnimeList 暂未返回排行榜。");
  return $("tr.ranking-list")
    .toArray()
    .map((element) => {
      const row = $(element),
        link = row.find("h3 a").first(),
        img = row.find("img").first();
      const details =
        row
          .find(".information")
          .html()
          ?.replace(/<br\s*\/?>/gi, " ")
          .trim() || "";
      return rating("mal", {
        id: malIdFrom(link.attr("href")),
        names: link.text(),
        rank: Number(row.find(".rank").text().trim()),
        score: row.find(".score .score-label").text().trim(),
        format: details.split(/[\s(]/)[0],
        year: details.match(/\b(?:19|20)\d{2}\b/)?.[0],
        cover: img.attr("data-src") || img.attr("src"),
      });
    })
    .filter(Boolean);
}

function parseMalSearch(html) {
  const $ = load(html);
  if (!$("title").text().includes("MyAnimeList"))
    throw Error("MyAnimeList 暂未返回搜索结果。");
  return $("a.hoverinfo_trigger.fw-b")
    .toArray()
    .map((element) => {
      const link = $(element),
        name = link.text();
      return rating("mal", {
        id: malIdFrom(link.attr("href")),
        names: name,
        format: link.closest("tr").children().eq(2).text().trim(),
      });
    })
    .filter(Boolean);
}

function parseMalDetail(html, id) {
  const $ = load(html);
  const title = $("h1.title-name").first().text().trim();
  if (!title) throw Error("MyAnimeList 暂未返回作品详情。");
  return rating("mal", {
    id,
    names: getNames(title, $("p.title-english").first().text()),
    score: $('[itemprop="ratingValue"]').first().text(),
    votes: $('[itemprop="ratingCount"]').first().text(),
    cover: $('meta[property="og:image"]').attr("content"),
  });
}

export function createAnimeRatings(preferences, options = {}) {
  const network = options.network || createSourceNetwork(preferences);
  const now = options.now || Date.now;
  const cache = new Map();
  const pending = new Map();

  async function cached(key, ttl, refresh, fetchValue) {
    key = (network.cacheKey?.() ?? "") + "|" + key;
    const hit = cache.get(key);
    if (!refresh && hit && hit.expires > now()) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve()
      .then(fetchValue)
      .then((value) => {
        cache.delete(key);
        const duration = value.results?.some(
          (result) => result.state === "unavailable",
        )
          ? Math.min(ttl, 60_000)
          : ttl;
        cache.set(key, { value, expires: now() + duration });
        while (cache.size > 160) cache.delete(cache.keys().next().value);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  const read = async (url, params) =>
    (
      await network.read(url, {
        maxBytes: 2_000_000,
        timeoutMs: 7000,
        ...params,
      })
    ).text;
  const json = async (url, params) => JSON.parse(await read(url, params));
  async function ani(query, variables) {
    const response = await json("https://graphql.anilist.co/", {
      jsonBody: { query, variables },
    });
    if (!response.data || response.errors?.length)
      throw Error("AniList 暂未返回评分数据。");
    return response.data;
  }

  async function doubanChart(category, offset, limit) {
    const tag = category === "tv" ? "日本动画" : "动画";
    const data = await json(
      `${douban}/j/search_subjects?type=${category}&tag=${encodeURIComponent(tag)}&sort=rank&page_limit=${limit}&page_start=${offset}`,
    );
    return data.subjects.map((item) =>
      rating("douban", {
        id: item.id,
        names: getNames(item.title, item.sub_title),
        year: item.year || item.release_year,
        score: item.rate,
        cover: item.cover,
        format: category,
      }),
    );
  }

  async function sampledPage(source, category, offset) {
    const limit = 50;
    if (source === "bangumi") {
      const data = await json(
        `${bangumi}/v0/subjects?type=2&cat=${category === "tv" ? 1 : 3}&sort=rank&limit=${limit}&offset=${offset}`,
      );
      return data.data.map(bangumiRow);
    }
    if (source === "anilist") {
      const data = await ani(
        `query ($page: Int, $format: MediaFormat) { Page(page: $page, perPage: ${limit}) {
        media(type: ANIME, format: $format, sort: [SCORE_DESC], isAdult: false) { ${GQL_FIELDS} }
      } }`,
        {
          page: offset / limit + 1,
          format: category === "tv" ? "TV" : "MOVIE",
        },
      );
      return data.Page.media.map(anilistRow);
    }
    if (source === "mal") {
      return parseMalRanking(
        await read(`${mal}/topanime.php?type=${category}&limit=${offset}`),
      );
    }
    return doubanChart(category, offset, limit);
  }

  async function readSample(source, category) {
    // Read contiguous leading pages so a title can match a lower placement
    // on another source. Only a bounded slice of each public chart is read.
    const count = source === "douban" ? 10 : 12;
    const offsets = Array.from({ length: count }, (_, index) => index * 50);
    const pages = [];
    for (let index = 0; index < offsets.length; index += 2) {
      const batch = await Promise.allSettled(
        offsets
          .slice(index, index + 2)
          .map((offset) => sampledPage(source, category, offset)),
      );
      pages.push(
        ...batch.map((result) =>
          (result.value || []).filter(
            (row) => row?.score != null && row.format === category,
          ),
        ),
      );
      if (index === 0 && !pages.some((rows) => rows.length)) return null;
    }
    const sample = pages.flat();
    if (pages.filter((rows) => rows.length >= 10).length < 3) return null;
    return {
      rows: sample,
      candidateIds: sample.map((row) => row.id),
      complete: pages.every((rows) => rows.length >= 10),
    };
  }
  const combined = createCombinedRankings(readSample, titleKey, {
    now,
    networkKey: network.cacheKey,
  });

  async function ranking(
    source,
    page = 1,
    refresh = false,
    category = "tv",
    limited = false,
  ) {
    if (
      (source !== "combined" && !RATING_SOURCES.includes(source)) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > (source === "combined" ? 100 : 20)
    )
      throw Error("排行榜来源或页码无效。");
    if (
      ["douban", "combined"].includes(source) &&
      !["tv", "movie"].includes(category)
    )
      throw Error("榜单分类无效。");
    if (source === "combined")
      return combined(category, page, refresh, limited);
    return cached(
      `rank:${source}:${page}:${category}`,
      30 * 60_000,
      refresh,
      async () => {
        const offset = (page - 1) * pageSize;
        let rows, hasNext;
        if (source === "bangumi") {
          const data = await json(
            `${bangumi}/v0/subjects?type=2&sort=rank&limit=${pageSize}&offset=${offset}`,
          );
          rows = data.data.map(bangumiRow);
          hasNext = offset + pageSize < data.total;
        } else if (source === "anilist") {
          const data = await ani(
            `query ($page: Int) { Page(page: $page, perPage: ${pageSize}) {
          pageInfo { hasNextPage } media(type: ANIME, sort: [SCORE_DESC], isAdult: false) { ${GQL_FIELDS} }
        } }`,
            { page },
          );
          rows = data.Page.media.map(anilistRow);
          hasNext = data.Page.pageInfo.hasNextPage;
        } else if (source === "mal") {
          const start = Math.floor(offset / malPageSize) * malPageSize;
          const top = await cached(
            "mal-top:" + start,
            30 * 60_000,
            refresh,
            () =>
              read(mal + "/topanime.php?limit=" + start).then(parseMalRanking),
          );
          rows = top.slice(offset - start, offset - start + pageSize);
          hasNext =
            top.length === malPageSize ||
            top.length > offset - start + pageSize;
        } else {
          rows = await doubanChart(category, offset, pageSize);
          hasNext = rows.length === pageSize;
        }
        return {
          source,
          page,
          hasNext: Boolean(hasNext && page < 20),
          items: rows
            .map(
              (row, i) => row && { ...row, rank: row.rank ?? offset + i + 1 },
            )
            .filter(Boolean),
        };
      },
    );
  }

  const searchNames = (target) => {
    const seen = new Set();
    return target.names
      .filter((name) => {
        const key = titleKey(name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4);
  };
  async function byName(target, fetchRows) {
    const rows = [];
    for (const name of searchNames(target)) {
      rows.push(...(await fetchRows(name)));
      const match = matchAnimeRating(rows, target);
      if (match) return match;
    }
    return null;
  }

  async function lookup(input, refresh = false) {
    const title = clean(input.title);
    const ids = Object.fromEntries(
      RATING_SOURCES.map((source) => [source, numberId(input.ids?.[source])]),
    );
    if (!title) throw Error("请输入番剧名称。");
    return cached(
      JSON.stringify({
        title,
        ids,
        year: yearOf(input.year),
        format: clean(input.format),
      }),
      15 * 60_000,
      refresh,
      async () => {
        const target = {
          title,
          names: getNames(title.split(/\s+[/／]\s+/u)),
          year: yearOf(input.year),
          format: formatKey(input.format),
        };
        const call = async (source, fetchRating) => {
          try {
            const value = await fetchRating();
            return {
              source,
              state: value ? "matched" : "unmatched",
              rating: value || null,
            };
          } catch {
            return { source, state: "unavailable", rating: null };
          }
        };
        function extend(target, row) {
          return row
            ? {
                ...target,
                year: target.year || row.year,
                format: target.format || row.format,
                names: getNames(target.names, row.names),
              }
            : target;
        }
        function compatible(a, b) {
          return (
            !(a?.year && b?.year && a.year !== b.year) &&
            compatibleFormat(a?.format, b?.format)
          );
        }
        async function fetchBangumi(query) {
          if (ids.bangumi)
            return bangumiRow(await readBangumi(network, ids.bangumi));
          for (const name of searchNames(query)) {
            const found = await findBangumi(network, name, (rows) =>
              matchAnimeRating(rows.map(bangumiRow).filter(Boolean), query),
            );
            if (found)
              return bangumiRow(await readBangumi(network, found.id)) || found;
          }
          return null;
        }
        async function fetchAniList(query) {
          if (ids.anilist || ids.mal) {
            const field = ids.anilist ? "id" : "idMal";
            try {
              const data = await ani(
                `query ($id: Int) { Media(${field}: $id, type: ANIME) { ${GQL_FIELDS} } }`,
                { id: Number(ids.anilist || ids.mal) },
              );
              return data.Media ? anilistRow(data.Media) : null;
            } catch (error) {
              if (!ids.mal || ids.anilist) throw error;
            }
          }
          return byName(query, async (name) => {
            const data = await ani(
              `query ($name: String) { Page(perPage: 8) {
              media(search: $name, type: ANIME) { ${GQL_FIELDS} }
            } }`,
              { name },
            );
            return data.Page.media.map(anilistRow).filter(Boolean);
          });
        }
        const base = await Promise.all([
          call("bangumi", () => fetchBangumi(target)),
          call("anilist", () => fetchAniList(target)),
        ]);
        if (
          base[0].rating &&
          base[1].rating &&
          !compatible(base[0].rating, base[1].rating)
        )
          base[ids.anilist || ids.mal ? 0 : 1].rating = null;
        if (base[0].rating && !base[1].rating && !ids.anilist) {
          base[1] = await call("anilist", () =>
            fetchAniList(extend(target, base[0].rating)),
          );
        } else if (base[1].rating && !base[0].rating && !ids.bangumi) {
          base[0] = await call("bangumi", () =>
            fetchBangumi(extend(target, base[1].rating)),
          );
        }
        const [bgmResult, aniResult] = base.map((result) => result.rating);
        for (const row of base)
          if (!row.rating && row.state === "matched") row.state = "unmatched";
        const extended = extend(extend(target, bgmResult), aniResult);
        if (aniResult?.format === "special") extended.format = "special";
        const rest = await Promise.all([
          call("mal", async () => {
            const id = ids.mal || aniResult?.malId;
            if (id) return parseMalDetail(await read(mal + "/anime/" + id), id);
            const matched = await byName(extended, async (name) => {
              const response = await network.read(
                mal + "/anime.php?q=" + encodeURIComponent(name) + "&cat=anime",
                { maxBytes: 2_000_000, timeoutMs: 7000 },
              );
              const id = malIdFrom(response.url);
              const detail = id && parseMalDetail(response.text, id);
              return detail ? [detail] : parseMalSearch(response.text);
            });
            return matched
              ? parseMalDetail(
                  await read(mal + "/anime/" + matched.id),
                  matched.id,
                )
              : null;
          }),
          call("douban", async () => {
            const id = ids.douban;
            const matched = id
              ? null
              : await byName(extended, async (name) => {
                  const data = await json(
                    douban + "/j/subject_suggest?q=" + encodeURIComponent(name),
                  );
                  return data
                    .map((item) =>
                      rating("douban", {
                        id: item.id,
                        names: getNames(item.title, item.sub_title),
                        year: item.year,
                        cover: item.img,
                      }),
                    )
                    .filter(Boolean);
                });
            if (!id && !matched) return null;
            const data = await json(
              douban + "/j/subject_abstract?subject_id=" + (id || matched.id),
            );
            if (!data.subject) throw Error("豆瓣暂未返回作品详情。");
            if (
              !data.subject.types?.includes("动画") ||
              !compatibleFormat(
                extended.format,
                data.subject.is_tv ? "tv" : "movie",
              )
            )
              return null;
            return rating("douban", {
              id: data.subject.id,
              names: matched?.names || data.subject.title,
              year: data.subject.release_year,
              format: data.subject.is_tv ? "TV" : "MOVIE",
              score: data.subject.rate,
              cover: matched?.cover,
            });
          }),
        ]);
        return { title, results: [base[0], rest[0], base[1], rest[1]] };
      },
    );
  }
  return { ranking, lookup, close: () => network.close?.() };
}
