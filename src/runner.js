import { createStateStore } from "./state-store.js";
import { downloadPlan } from "./download-plan.js";
import { failedAttempt } from "./retries.js";
import { own, put } from "./dictionary.js";
import { noteFeedSuccess } from "./continuity.js";
import fs from "node:fs";
import { migrateEpisodeState, episodeRecorded } from "./episode-dedupe.js";
import { watchedOperations, operationCovers } from "./watched-operations.js";
import path from "node:path";
import { atomicWrite, loadConfig } from "./config.js";
import { fetchFeed, matches, sourceKey, matchingAnimeRule } from "./feed.js";
import { applyAnimeBindings } from "./anime-bindings.js";
import { QbClient } from "./qb.js";
import { readAniBTControl, siteExcluded } from "./anibt-control.js";
import { explicitEpisodeWatched } from "./progress.js";
import { groupPriority, priorityWait } from "./priority.js";

export function emptyState() {
  return {
    version: 1,
    sources: {},
    done: {},
    episodes: {},
    pending: {},
    updatedAt: null,
  };
}
export function loadState(file, config = {}, history = []) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s.version !== 1 || !s.sources || !s.done || !s.episodes || !s.pending)
      throw new Error("bad");
    return migrateEpisodeState(s, config, history);
  } catch (e) {
    if (e.code === "ENOENT") return emptyState();
    throw new Error(
      "下载记录无法读取，已停止以避免重复下载。请检查 data/state.json。",
    );
  }
}
export function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid;
      try {
        pid = Number(fs.readFileSync(file, "utf8"));
      } catch {}
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error("另一个追番进程正在运行，请先停止它。");
        } catch (err) {
          if (err.code !== "ESRCH") throw err;
        }
      }
      // Do not remove a newly-created lock whose owner hasn't finished writing its PID.
      else if (Date.now() - fs.statSync(file).mtimeMs < 30000)
        throw new Error("追番进程正在启动，请稍后重试。");
      fs.unlinkSync(file);
    }
  }
  throw new Error("无法取得运行锁。");
}
export const statePath = (config, configFile) =>
  path.resolve(path.dirname(configFile), config.stateFile);
export function normalizeBackfillSelection(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 2000 ||
    value.some((id) => typeof id !== "string" || !id || id.length > 2000)
  )
    throw new Error("请至少勾选一集需要补下载的资源。");
  return [...new Set(value)];
}
export async function runOnce(config, configFile, options = {}, deps = {}) {
  const selected =
    options.selectedIds === undefined
      ? null
      : new Set(normalizeBackfillSelection(options.selectedIds));
  if (selected && !options.backfill)
    throw new Error("指定集数仅适用于补下载。");
  const repository = createStateStore(configFile);
  if (repository.pending().length && !options.dryRun) {
    repository.recover();
    config = loadConfig(configFile);
  }
  repository.assertClean();
  const file = statePath(config, configFile);
  let manual = {};
  try {
    manual = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(configFile), "data/manual-downloads.json"),
        "utf8",
      ),
    );
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error("手动下载记录无法读取，已暂停自动提交。");
  }
  const state = loadState(file, config, Object.values(manual));
  let items = [],
    feedError = null;
  if (!options.queueOnly)
    try {
      items = applyAnimeBindings(
        await (deps.fetchFeed || fetchFeed)(config.rssUrl),
        config,
      );
    } catch (error) {
      feedError = error;
    }
  if (feedError)
    (deps.log || console.log)(
      "RSS 暂时无法读取；继续核对并处理已保存的待重试任务。",
    );
  const source = sourceKey(config.rssUrl);
  if (
    feedError &&
    !Object.values(state.pending).some((e) => e.source === source)
  )
    throw feedError;
  const unsettled = watchedOperations(configFile).pending();
  const siteControl = readAniBTControl(configFile, config);
  const clock = () => (deps.now ? Number(new Date(deps.now())) : Date.now());
  const now = clock();
  if (!options.dryRun && !feedError && !options.queueOnly)
    noteFeedSuccess(configFile, { now, previousAt: state.updatedAt || "" });
  let tracking = {};
  try {
    tracking = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(configFile), "data/tracking.json"),
        "utf8",
      ),
    );
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error("观看记录无法读取，已暂停自动提交。");
  }
  const matchesHere = (raw) => {
    const item = applyAnimeBindings([raw], config)[0];
    if (unsettled.some((op) => operationCovers(op, item, config)))
      return {
        ok: false,
        reason: "删除结果或本地观看记录待恢复，暂停相关下载",
      };
    if (explicitEpisodeWatched(item, tracking, config))
      return { ok: false, reason: "本集已明确标记已看，不再自动下载" };
    return siteExcluded(item, siteControl)
      ? { ok: false, reason: "已从 AniBT 退订" }
      : matches(item, config, new Date(now));
  };
  if (selected) {
    const available = new Map(
      [
        ...items,
        ...Object.values(state.pending)
          .filter((e) => e.source === source)
          .map((e) => e.item),
      ].map((item) => [item.id, item]),
    );
    if (
      [...selected].some(
        (id) => !available.has(id) || !matchesHere(available.get(id)).ok,
      )
    )
      throw Object.assign(
        new Error("补下载清单或筛选条件已变化，请重新预览并勾选。"),
        { status: 409 },
      );
  }
  const src = state.sources[source];
  const first = !src;
  const baseline =
    !options.queueOnly &&
    !feedError &&
    first &&
    config.firstRun === "baseline" &&
    !options.backfill;
  const report = {
    total: items.length,
    matched: 0,
    planned: 0,
    added: 0,
    existing: 0,
    skipped: 0,
    baseline: 0,
    failed: 0,
    waiting: 0,
    dryRun: !!options.dryRun,
    queueOnly: !!options.queueOnly,
    ...(feedError
      ? {
          feedError: "RSS 暂时无法读取，本轮仅处理持久队列",
          feedRetryAfterSeconds: Number.isFinite(feedError.retryAfterSeconds)
            ? Math.max(0, feedError.retryAfterSeconds)
            : 0,
        }
      : {}),
  };
  const log = deps.log || console.log;
  const commit = () => {
    state.updatedAt = new Date().toISOString();
    repository.write(file, state);
  };
  if (baseline) {
    report.baseline = items.length;
    if (!options.dryRun) {
      state.sources[source] = {
        initializedAt: new Date().toISOString(),
        baselineIds: items.map((i) => i.id),
      };
      commit();
    }
    log(
      `首次运行：${items.length} 条现有发布已${options.dryRun ? "预览为" : "记录为"}基线；之后只追踪新发布。补下载现有资源请用 run --backfill。`,
    );
  }
  const baselineIds = new Set(src?.baselineIds || []);
  let siteBaselineChanged = false;
  if (src) {
    src.siteBaselineVersions ??= {};
    for (const [bgmId, marker] of Object.entries(siteControl.baseline)) {
      const version = typeof marker === "string" ? marker : marker.version;
      if (src.siteBaselineVersions[bgmId] === version) continue;
      const existing = items.filter((item) => String(item.bgmId) === bgmId);
      if (!existing.length) continue;
      const cutoff =
        typeof marker === "object" ? Date.parse(marker.before) : Infinity;
      for (const item of existing)
        if (
          !Number.isFinite(Date.parse(item.publishedAt)) ||
          Date.parse(item.publishedAt) <= cutoff
        )
          baselineIds.add(item.id);
      src.siteBaselineVersions[bgmId] = version;
      siteBaselineChanged = true;
    }
    if (siteBaselineChanged) {
      src.baselineIds = [...baselineIds];
      if (!options.dryRun) commit();
    }
  }
  const plan = downloadPlan({
    items,
    state,
    config,
    source,
    match: matchesHere,
    now,
    baseline,
    baselineIds,
    selected,
    backfill: options.backfill,
    feedError,
    queueOnly: options.queueOnly,
  });
  report.total = plan.rows.length;
  report.rssTotal = items.length;
  report.planned = plan.planned;
  report.matched = plan.rows.filter((r) => r.matched).length;
  for (const row of plan.rows) log("[" + row.reason + "] " + row.item.title);
  report.waiting = plan.rows.filter((r) =>
    [
      "priority-wait",
      "retry-wait",
      "paused",
      "source-wait",
      "confirmation-wait",
    ].includes(r.status),
  ).length;
  report.skipped = plan.rows.filter((r) => r.status === "excluded").length;
  report.existing = plan.rows.filter((r) =>
    ["recorded", "duplicate"].includes(r.status),
  ).length;
  if (options.dryRun) return report;
  if (!options.queueOnly && !feedError && !state.sources[source])
    state.sources[source] = {
      initializedAt: new Date(now).toISOString(),
      baselineIds: selected ? items.map((i) => i.id) : [],
    };
  state.prioritySince ??= {};
  for (const row of plan.rows) {
    const { item } = row;
    if (!["excluded", "baseline"].includes(row.status))
      for (const key of row.pendingKeys)
        if (key !== item.id || row.status === "recorded")
          delete state.pending[key];
    if (row.status === "duplicate") {
      put(state.done, item.id, {
        at: new Date(now).toISOString(),
        status: "episode-duplicate",
        title: item.title,
      });
      delete state.pending[item.id];
      continue;
    }
    if (["excluded", "recorded", "baseline"].includes(row.status)) continue;
    const entry = put(state.pending, item.id, { ...row.entry, item, source });
    if (!options.queueOnly) entry.preferMagnet = !!feedError;
    entry.waitingForSource = row.status === "source-wait";
    if (row.status === "priority-wait") {
      state.prioritySince[row.wait.key] = row.wait.first;
      entry.waitUntil = row.wait.until;
    } else delete entry.waitUntil;
    if (row.status === "invalid") {
      put(
        state.pending,
        item.id,
        failedAttempt(
          entry,
          Object.assign(new Error(row.reason), { code: "MISSING_HASH" }),
          now,
        ),
      );
      report.failed++;
    }
    if (row.status === "source-wait") entry.lastError = row.reason;
  }
  commit();
  if (!plan.ready.length) return report;
  const qb = deps.qb || new QbClient(config);
  let hashes;
  try {
    try {
      await (qb.connectForDownload ? qb.connectForDownload() : qb.login());
      await qb.ensureCategory();
      hashes = new Set((await qb.list()).map((t) => t.hash.toLowerCase()));
    } catch (error) {
      error.stage = "downloader-connect";
      for (const { item } of plan.ready) {
        put(
          state.pending,
          item.id,
          failedAttempt(own(state.pending, item.id), error, clock()),
        );
        report.failed++;
      }
      commit();
      return report;
    }
    const uncertain = new Set();
    for (const { item } of plan.ready) {
      if (config.dedupeEpisodes && uncertain.has(item.episodeKey)) {
        report.waiting++;
        continue;
      }
      if (config.dedupeEpisodes && episodeRecorded(state, item)) {
        put(state.done, item.id, {
          at: new Date(now).toISOString(),
          status: "episode-duplicate",
          title: item.title,
        });
        delete state.pending[item.id];
        report.existing++;
        commit();
        continue;
      }
      let result;
      const exists = hashes.has(item.infoHash),
        entry = own(state.pending, item.id);
      try {
        if (!exists) {
          const submission =
            (feedError || entry.preferMagnet) && !item.torrentData
              ? {
                  ...item,
                  torrentUrl: "",
                  magnet: "magnet:?xt=urn:btih:" + item.infoHash,
                }
              : item;
          result = await qb.add(submission, {
            organizeByAnime: true,
            onSubmitting: ({ savePath } = {}) => {
              entry.submissionAttemptedAt ??= new Date(now).toISOString();
              if (savePath) entry.submissionSavePath = savePath;
              commit();
            },
          });
        }
      } catch (error) {
        if (error.submissionRejected) {
          delete entry.submissionAttemptedAt;
          delete entry.submissionSavePath;
        }
        if (entry.submissionAttemptedAt) error.submissionAttempted = true;
        if (error.submissionAttempted) {
          entry.submissionAttemptedAt ??= new Date(now).toISOString();
          uncertain.add(item.episodeKey);
        }
        put(state.pending, item.id, failedAttempt(entry, error, clock()));
        report.failed++;
        commit();
        log("[待重试] " + item.title + "：" + error.message);
        continue;
      }
      const recovered = exists && !!entry.submissionAttemptedAt,
        owned = !exists || recovered;
      put(state.done, item.id, {
        at: new Date(now).toISOString(),
        status: owned ? "added" : "existing",
        title: item.title,
        animeTitle: item.animeTitle,
        bgmId: item.bgmId,
        episode: item.episode,
        version: item.version,
        hash: item.infoHash,
        releaseUrl: item.releaseUrl,
        paused: config.qb.paused,
        ...(result?.savePath || entry.submissionSavePath
          ? { savePath: result?.savePath || entry.submissionSavePath }
          : {}),
        ...(recovered
          ? {
              confirmationRecovered: true,
              submittedAt: entry.submissionAttemptedAt,
            }
          : {}),
      });
      if (item.episodeKey) put(state.episodes, item.episodeKey, item.id);
      delete state.pending[item.id];
      hashes.add(item.infoHash);
      commit();
      report[owned ? "added" : "existing"]++;
      log(
        "[" +
          (recovered ? "已恢复添加确认" : exists ? "qB 已存在" : "已添加") +
          "] " +
          item.title,
      );
    }
  } finally {
    await qb.logout();
  }
  return report;
}
