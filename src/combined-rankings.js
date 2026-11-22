const pageSize = 25;
const cacheMs = 6 * 60 * 60 * 1000;
const refreshDelay = 60_000;
const minimumReference = 75;
const priorVotes = 100;
const disagreementThreshold = 20;
export const COMBINED_SOURCES = ["bangumi", "mal", "anilist", "douban"];

const rowKey = (row) => row.source + ":" + row.id;
const seasons = (row, key) =>
  new Set(
    row.names
      .slice(0, 3)
      .flatMap((name) =>
        [...key(name).matchAll(/season(\d+)/g)].map((match) => match[1]),
      ),
  );

function compatible(group, row, key) {
  const right = seasons(row, key);
  return group.every((other) => {
    if (row.year && other.year && row.year !== other.year) return false;
    const left = seasons(other, key);
    return (
      !left.size || !right.size || [...left].some((value) => right.has(value))
    );
  });
}

function addSourceRows(groups, rows, key) {
  const aliases = new Map();
  for (const group of groups) {
    // A trusted AniList → MAL ID wins over any title-only candidate.
    if (group.some((row) => row.source === rows[0].source)) continue;
    for (const name of group.flatMap((row) => row.names)) {
      const normalized = key(name);
      if (normalized.length < 2) continue;
      if (!aliases.has(normalized)) aliases.set(normalized, new Set());
      aliases.get(normalized).add(group);
    }
  }
  const proposed = new Map();
  const byGroup = new Map();
  for (const row of rows) {
    const matches = new Set(
      row.names.flatMap((name) => [...(aliases.get(key(name)) || [])]),
    );
    const possible = [...matches].filter((group) =>
      compatible(group, row, key),
    );
    if (possible.length !== 1) continue;
    const group = possible[0];
    proposed.set(row.id, group);
    byGroup.set(group, (byGroup.get(group) || 0) + 1);
  }
  for (const row of rows) {
    const group = proposed.get(row.id);
    if (group && byGroup.get(group) === 1) group.push(row);
    else groups.push([row]);
  }
}

function groupWorks(bySource, key) {
  const groups = (bySource.get("anilist") || []).map((row) => [row]);
  const direct = new Map();
  for (const group of groups) {
    const id = group[0].malId;
    if (id) direct.set(id, direct.has(id) ? null : group);
  }
  const remaining = (bySource.get("mal") || []).filter((row) => {
    const group = direct.get(row.id);
    if (!group) return true;
    group.push(row);
    return false;
  });
  for (const rows of [
    remaining,
    bySource.get("bangumi"),
    bySource.get("douban"),
  ])
    if (rows?.length) addSourceRows(groups, rows, key);
  return groups;
}

const average = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const rounded = (value) => Math.round(value * 10) / 10;
const nativeScale = (row) => (row.score * 100) / row.scale;
const scored = (row) =>
  Number.isFinite(row.score) && row.score > 0 && row.score <= row.scale;

function calibrate(reference, source) {
  const prior = average(reference.map(nativeScale));
  function adjusted(row) {
    const score = nativeScale(row);
    if (!row.votes || !["bangumi", "anilist"].includes(source)) return score;
    return (row.votes * score + priorVotes * prior) / (row.votes + priorVotes);
  }
  const values = reference.map(adjusted).sort((a, b) => a - b);
  return (row) => {
    const value = adjusted(row);
    let below = 0,
      tied = 0;
    for (const other of values) {
      if (Math.abs(other - value) < 1e-8) tied++;
      else if (other < value) below++;
      else break;
    }
    return {
      percentile: (100 * (below + tied / 2)) / values.length,
      adjustedScore: (value * row.scale) / 100,
      referenceSize: values.length,
    };
  };
}

function ordered(a, b) {
  return (
    b.index - a.index || b.coverage - a.coverage || a.id.localeCompare(b.id)
  );
}

function stabilityCheck(official, sources) {
  const count = Math.min(50, official.length);
  if (!count) return { count, checks: [] };
  const first = official.slice(0, count);
  const checks = sources.map((source) => {
    // Compare the same set of eligible works after removing one source.
    const order = official
      .map((row) => {
        const remaining = row.results.filter(
          (result) =>
            result.rating?.source !== source && result.state === "matched",
        );
        return {
          ...row,
          index: average(remaining.map((result) => result.rating.percentile)),
          coverage: remaining.length,
        };
      })
      .sort(ordered);
    const positions = new Map(order.map((row, index) => [row.id, index + 1]));
    return {
      source,
      retained: first.filter((row) => positions.get(row.id) <= count).length,
      topTenRetained: first
        .slice(0, 10)
        .filter((row) => positions.get(row.id) <= 10).length,
      largestShift: Math.max(
        ...first.map((row) => Math.abs(row.rank - positions.get(row.id))),
      ),
    };
  });
  return { count, checks };
}

export function buildCombinedRanks(samples, key) {
  const bySource = new Map(),
    calibrations = new Map(),
    candidates = new Set();
  for (const [source, pool] of samples) {
    if (!pool) continue;
    const rows = [
      ...new Map(pool.rows.filter(scored).map((row) => [row.id, row])).values(),
    ];
    if (rows.length < minimumReference) continue;
    bySource.set(source, rows);
    calibrations.set(source, calibrate(rows, source));
    for (const id of pool.candidateIds) candidates.add(source + ":" + id);
  }
  const available = [...bySource.keys()];
  const works = groupWorks(bySource, key).filter((group) =>
    group.some((row) => candidates.has(rowKey(row))),
  );
  const summaries = works.map((group) => {
    const canonical = ["bangumi", "douban", "anilist", "mal"]
      .map((source) => group.find((row) => row.source === source))
      .find(Boolean);
    const results = COMBINED_SOURCES.map((source) => {
      const rating = group.find((row) => row.source === source);
      if (!rating)
        return {
          source,
          state: bySource.has(source) ? "unmatched" : "unavailable",
          rating: null,
        };
      return {
        source,
        state: "matched",
        rating: { ...rating, ...calibrations.get(source)(rating) },
      };
    });
    const values = results.flatMap((result) =>
      result.rating ? [result.rating.percentile] : [],
    );
    const gap = Math.max(...values) - Math.min(...values);
    return {
      ...canonical,
      id: rowKey(canonical),
      index: average(values),
      coverage: values.length,
      disagreement: values.length >= 2 && gap >= disagreementThreshold,
      gap: rounded(gap),
      results,
      year: canonical.year || group.find((row) => row.year)?.year || "",
      cover: group.find((row) => row.cover)?.cover || "",
    };
  });
  const official = summaries
    .filter((row) => row.coverage >= 3)
    .sort(ordered)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
  const limited = summaries
    .filter((row) => row.coverage < 3)
    .sort((a, b) => b.coverage - a.coverage || ordered(a, b))
    .map((row) => ({ ...row, rank: null }));
  return {
    available,
    official,
    limited,
    stability: stabilityCheck(official, available),
    referenceCounts: Object.fromEntries(
      [...bySource].map(([source, rows]) => [source, rows.length]),
    ),
    partial:
      available.length < COMBINED_SOURCES.length ||
      [...samples.values()].some((pool) => pool && !pool.complete),
  };
}

export function createCombinedRankings(
  readSample,
  key,
  { now = Date.now, networkKey = () => "" } = {},
) {
  const snapshots = new Map(),
    pending = new Map(),
    attempted = new Map();

  async function read(category, refresh) {
    const previous = snapshots.get(category);
    const generation = networkKey();
    const stamp = now();
    const lifetime =
      previous?.partial || previous?.stale ? 10 * 60_000 : cacheMs;
    if (
      !refresh &&
      previous?.generation === generation &&
      stamp - previous.checkedAt < lifetime
    )
      return previous;
    const requestKey = category + "|" + generation;
    if (pending.has(requestKey)) return pending.get(requestKey);
    const recent = attempted.get(category);
    if (
      previous &&
      recent?.generation === generation &&
      stamp - recent.at < refreshDelay
    )
      return previous;
    attempted.set(category, { generation, at: stamp });
    const request = (async () => {
      const attempts = await Promise.allSettled(
        COMBINED_SOURCES.map((source) => readSample(source, category)),
      );
      const samples = new Map(
        COMBINED_SOURCES.map((source, index) => [
          source,
          attempts[index].value,
        ]),
      );
      const summary = buildCombinedRanks(samples, key);
      if (
        previous &&
        (previous.available.some(
          (source) => !summary.available.includes(source),
        ) ||
          (!previous.partial && summary.partial) ||
          (summary.partial &&
            !summary.official.length &&
            previous.official.length))
      ) {
        const retained = { ...previous, stale: true, checkedAt: now() };
        if (networkKey() === generation) snapshots.set(category, retained);
        return retained;
      }
      if (!summary.available.length)
        throw Error("暂时无法取得四站的榜单样本。");
      const completed = now();
      const next = {
        ...summary,
        updatedAt: completed,
        checkedAt: completed,
        generation,
        stale: false,
      };
      if (networkKey() === generation) snapshots.set(category, next);
      return next;
    })().finally(() => pending.delete(requestKey));
    pending.set(requestKey, request);
    return request;
  }

  return async function ranking(
    category,
    page,
    refresh = false,
    limited = false,
  ) {
    const snapshot = await read(category, refresh);
    const rows = limited ? snapshot.limited : snapshot.official;
    const offset = (page - 1) * pageSize;
    const items = rows.slice(offset, offset + pageSize).map((row) => ({
      ...row,
      index: rounded(row.index),
      topPercent: row.rank ? Math.ceil((row.rank * 100) / rows.length) : null,
      results: row.results.map((result) =>
        result.rating
          ? {
              ...result,
              rating: {
                ...result.rating,
                percentile: rounded(result.rating.percentile),
                adjustedScore: rounded(result.rating.adjustedScore),
              },
            }
          : result,
      ),
    }));
    return {
      source: "combined",
      page,
      items,
      hasNext: offset + pageSize < rows.length,
      metadata: {
        ranked: snapshot.official.length,
        limited: snapshot.limited.length,
        partial: snapshot.partial,
        stale: snapshot.stale,
        available: snapshot.available,
        referenceCounts: snapshot.referenceCounts,
        stability: snapshot.stability,
        updatedAt: snapshot.updatedAt,
      },
    };
  };
}
