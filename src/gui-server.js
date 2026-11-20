import { localSnapshots } from "./local-snapshots.js";
import { createStateStore } from "./state-store.js";
import {
  createPortableUpdater,
  guardPortableUpdate,
} from "./portable-updater.js";
import { createSubscriptionRoutes } from "./gui/subscription-routes.js";
import { createSettingsRoutes } from "./gui/settings-routes.js";
import { createDownloadRoutes } from "./gui/download-routes.js";
import { createBackupRoutes } from "./gui/backup-routes.js";
import { createProgressRoutes } from "./gui/progress-routes.js";
import { queueToken } from "./retries.js";
import { own } from "./dictionary.js";
import {
  backupSettings,
  setBackupSettings,
  listAutomaticBackups,
  readAutomaticBackup,
  maybeAutomaticBackup,
  continuityStatus,
  acknowledgeContinuity,
  noteFeedSuccess,
} from "./continuity.js";
import {
  getReviewDraft,
  writeReviewDraft,
  clearReviewDraft,
  readDrafts,
} from "./review-drafts.js";
import { APP_VERSION, createReleaseChecker } from "./release-info.js";
import { watchHealthStatus } from "./watch-health.js";
import { createSourceNetwork } from "./source-network.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  defaults,
  clone,
  loadConfig,
  validateConfig,
  atomicWrite,
  protectPassword,
  redactedConfig,
  restoreDefaultPreferences,
} from "./config.js";
import {
  fetchFeed,
  matches,
  safeFetch,
  sourceKey,
  matchingAnimeRule,
  beijingDate,
  effectiveFilters,
  norm,
} from "./feed.js";
import {
  loadState,
  statePath,
  lock,
  runOnce,
  normalizeBackfillSelection,
} from "./runner.js";
import { QbClient, sleep } from "./qb.js";
import { mergeGroupOptions } from "./groups.js";
import { createDiscovery } from "./discover.js";
import { validateProxy } from "./source-network.js";
import { nativeNotification } from "./notifications.js";
import {
  notificationHistory,
  markNotificationsRead,
} from "./notification-history.js";
import {
  animeFolderName,
  animeDownloadPath,
  discoveryDownloadItem,
} from "./download-path.js";
import {
  exportBackup,
  validateBackup,
  verifyBackupPaths,
} from "./migration.js";
import { createArtwork } from "./artwork.js";
import {
  episodeContext,
  showContext,
  deletionManifest,
  digest,
} from "./episode-actions.js";
import {
  buildProgress,
  explicitEpisodeWatched,
  episodeNumber,
  watchedLibraryKeys,
  animeKey,
} from "./progress.js";
import { priorityWait } from "./priority.js";
import { createAnimeResources } from "./anime-resources.js";
import { submitAgain, resetCompletion } from "./reprocessing.js";
import { createAnimeCatalog } from "./anibt-catalog.js";
import {
  catchupTiming,
  catchupRecommendations,
  resourceDownloadConfig,
} from "./catchup.js";
import { validateReview } from "./reviews.js";
import { inspectHistory, openHistoryFolder } from "./history-actions.js";
import { readInterfaceState, patchInterfaceState } from "./interface-state.js";
import { applyAnimeBindings } from "./anime-bindings.js";
import { episodeRecorded } from "./episode-dedupe.js";
import {
  watchedOperations,
  deletionResult,
  finishDeletion,
  verifyDeletion,
  commitWatchedOperation,
} from "./watched-operations.js";
import { overviewDetails } from "./overview-details.js";
import {
  maintenanceStatus,
  readMaintenance,
  afterCleanup,
  setMonthlyCleanup,
  cleanupHistory,
  runMonthlyCleanup,
} from "./maintenance.js";
import {
  accountKeyHash,
  readAniBTControl,
  saveAniBTControl,
  siteExcluded,
} from "./anibt-control.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function publicConfig(c) {
  const visible = redactedConfig(c);
  visible.rssConfigured = !!c.rssUrl;
  visible.passwordConfigured = !!(
    c.qb.password ||
    c.qb.passwordEncrypted ||
    process.env.QBITTORRENT_PASSWORD
  );
  delete visible.qb.password;
  delete visible.qb.passwordEncrypted;
  return visible;
}
export function applyConfigPatch(current, input) {
  const c = clone(current);
  if (input.rssUrl?.trim()) c.rssUrl = input.rssUrl.trim();
  if (input.intervalSeconds !== undefined)
    c.intervalSeconds = Number(input.intervalSeconds);
  if (input.startDate !== undefined) c.startDate = input.startDate;
  if (input.startEpisode !== undefined) c.startEpisode = input.startEpisode;
  if (input.dedupeEpisodes !== undefined)
    c.dedupeEpisodes = input.dedupeEpisodes;
  if (input.notifications?.enabled !== undefined)
    c.notifications.enabled = input.notifications.enabled;
  if (input.notifications?.openOnDownload !== undefined)
    c.notifications.openOnDownload = input.notifications.openOnDownload;
  if (input.filters)
    for (const key of Object.keys(defaults.filters))
      if (input.filters[key] !== undefined) c.filters[key] = input.filters[key];
  if (input.bindings !== undefined) c.bindings = input.bindings;
  if (input.rules !== undefined) c.rules = input.rules;
  if (input.qb) {
    for (const key of [
      "url",
      "username",
      "savePath",
      "category",
      "paused",
      "autoStart",
      "executable",
    ])
      if (input.qb[key] !== undefined) c.qb[key] = input.qb[key];
    if (input.qb.password) {
      c.qb.passwordEncrypted = protectPassword(input.qb.password);
      c.qb.password = "";
    }
  }
  validateConfig(c);
  return c;
}
function executeScript(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/background.ps1"),
        action,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("error", () => reject(new Error("无法调用后台管理程序。")));
    child.once("exit", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(err.trim() || out.trim() || "后台操作失败。")),
    );
  });
}
function backgroundStatus(configFile) {
  const startup = process.env.APPDATA
    ? path.join(
        process.env.APPDATA,
        "Microsoft/Windows/Start Menu/Programs/Startup/AniBT-qB.lnk",
      )
    : "";
  return {
    ...watchHealthStatus(configFile),
    autostart: !!startup && fs.existsSync(startup),
  };
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error("本机记录无法读取，请检查 " + path.basename(file) + "。");
  }
}
function discoveryAssociation(a) {
  if (a === undefined) return {};
  if (
    !a ||
    typeof a.title !== "string" ||
    !a.title.trim() ||
    a.title.length > 300 ||
    typeof a.bgmId !== "string" ||
    (a.bgmId !== "" && !/^\d{1,8}$/.test(a.bgmId)) ||
    typeof a.episode !== "string" ||
    !/^\d{1,4}$/.test(a.episode) ||
    Number(a.episode) < 1
  )
    throw new Error("补集关联信息无效。");
  return {
    animeTitle: a.title,
    bgmId: a.bgmId,
    episode: a.episode,
    version: "v1",
  };
}
function tail(file) {
  try {
    const stat = fs.statSync(file),
      n = Math.min(stat.size, 16000),
      fd = fs.openSync(file, "r"),
      b = Buffer.alloc(n);
    try {
      fs.readSync(fd, b, 0, n, stat.size - n);
    } finally {
      fs.closeSync(fd);
    }
    return b.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-35);
  } catch {
    return [];
  }
}
export function describeItems(
  items,
  config,
  state,
  siteControl = {},
  tracking = {},
) {
  items = applyAnimeBindings(items, config);
  const source = state.sources[sourceKey(config.rssUrl)];
  const baseline = new Set(source?.baselineIds || []);
  const watchedKeys = watchedLibraryKeys(tracking, config);
  return items.map((item) => {
    const match = explicitEpisodeWatched(item, tracking, config)
      ? { ok: false, reason: "本集已明确标记已看，不再自动下载" }
      : siteExcluded(item, siteControl)
        ? { ok: false, reason: "已从 AniBT 退订" }
        : matches(item, config);
    const status = !match.ok
      ? "excluded"
      : own(state.done, item.id)
        ? "recorded"
        : config.dedupeEpisodes &&
            item.episodeKey &&
            episodeRecorded(state, item)
          ? "duplicate"
          : baseline.has(item.id)
            ? "baseline"
            : "candidate";
    const wait =
      match.ok && status === "candidate"
        ? priorityWait(item, config, state, sourceKey(config.rssUrl))
        : null;
    return {
      id: item.id,
      inWatchedLibrary: watchedKeys.has(
        animeKey(applyAnimeBindings([item], config)[0]),
      ),
      title: item.title,
      animeTitle: item.animeTitle,
      linkedTitle: item.linkedTitle || "",
      bgmId: item.bgmId,
      siteUnsubscribed: siteControl.unsubscribed?.[item.bgmId] === true,
      episode: item.episode,
      version: item.version,
      folderName: animeFolderName(item),
      decision: !match.ok
        ? match.reason
        : status === "recorded"
          ? "已经处理，不会自动重复提交"
          : status === "duplicate"
            ? "同一集已有处理记录，不再自动下载其他版本"
            : status === "baseline"
              ? "首次基线中的旧发布，需要手动选集补下载"
              : wait
                ? wait.reason
                : !source && config.firstRun === "baseline"
                  ? "首次检查将记为基线，不会自动补下载旧发布"
                  : "下次检查可参与提交，仍需经过优先级、同集与 qB 哈希去重",
      groupName: item.groupName,
      groupSlug: item.groupSlug,
      resolution: item.resolution,
      languages: item.languages,
      subtitles: item.subtitles,
      publishedAt: item.publishedAt,
      episodeKey: item.episodeKey,
      matched: match.ok,
      reason: wait?.reason || match.reason,
      status: wait ? "waiting" : status,
    };
  });
}
const guiAssetNames = {
  "/": "index.html",
  "/app.js": "app.js",
  "/settings.js": "settings.js",
  "/status.js": "status.js",
  "/performance.js": "performance.js",
  "/motion.js": "motion.js",
  "/motion.css": "motion.css",
  "/overview-twilight.webp": "overview-twilight.webp",
  "/refined.css": "refined.css",
  "/morph.css": "morph.css",
  "/apple.css": "apple.css",
  "/apple.js": "apple.js",
  "/operation-recovery.js": "operation-recovery.js",
  "/queue.js": "queue.js",
  "/morph.js": "morph.js",
  "/covers.js": "covers.js",
  "/backfill.js": "backfill.js",
  "/history.js": "history.js",
  "/discover.js": "discover.js",
  "/anibt.js": "anibt.js",
  "/help.js": "help.js",
  "/workbench.js": "workbench.js",
  "/reviews.js": "reviews.js",
  "/library-tools.js": "library-tools.js",
  "/episode-actions.js": "episode-actions.js",
  "/resources.js": "resources.js",
  "/overview.js": "overview.js",
  "/maintenance.js": "maintenance.js",
  "/improvements.js": "improvements.js",
  "/session.js": "session.js",
  "/history-actions.js": "history-actions.js",
  "/settings-defaults.js": "settings-defaults.js",
  "/theme.js": "theme.js",
  "/style.css": "style.css",
  "/icon.svg": "icon.svg",
};

function readGuiAssets(uiRoot) {
  const assets = new Map();
  for (const [url, name] of Object.entries(guiAssetNames)) {
    try {
      assets.set(url, {
        name,
        content: fs.readFileSync(path.join(uiRoot, name)),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return assets;
}

export function makeApplication({
  configFile,
  token = randomBytes(32).toString("hex"),
  uiRoot = path.join(root, "ui"),
  deps = {},
}) {
  // Pin the frontend to this server process so replacing files on disk cannot mix versions.
  const assets = readGuiAssets(uiRoot);
  const stateStore = createStateStore(configFile);
  const snapshots = localSnapshots(configFile);
  const atomicWrite = (file, value) => stateStore.write(file, value);
  let busy = null,
    feedCache = null,
    groupCache = null,
    qbCache = null,
    qbPromise = null;
  const animeGroupCache = new Map(),
    feedPromises = new Map();
  let feedGeneration = 0,
    activeFeedKey = "";
  const windows = new Set();
  let idleTimer;
  const preferencesFile = path.join(
    path.dirname(configFile),
    "data/preferences.json",
  );
  const preferenceDefaults = {
    theme: "system",
    design: "classic",
    networkMode: "auto",
    proxyUrl: "http://127.0.0.1:7890",
  };
  const preferences = () => {
    try {
      const p = JSON.parse(fs.readFileSync(preferencesFile, "utf8"));
      return {
        theme: ["system", "light", "dark"].includes(p.theme)
          ? p.theme
          : "system",
        design: ["classic", "morph", "apple"].includes(p.design)
          ? p.design
          : "classic",
        networkMode: ["auto", "direct", "custom"].includes(p.networkMode)
          ? p.networkMode
          : "auto",
        proxyUrl: p.proxyUrl
          ? validateProxy(p.proxyUrl)
          : preferenceDefaults.proxyUrl,
      };
    } catch {
      return { ...preferenceDefaults };
    }
  };
  const discovery = deps.discovery || createDiscovery(preferences);
  const animeResources =
    deps.animeResources || createAnimeResources(preferences);
  const fallbackResources = new Map();
  const artwork = deps.artwork || createArtwork(preferences);
  const animeCatalog = deps.animeCatalog || createAnimeCatalog(preferences);
  async function completedAnime(bgmId, title) {
    const anime = await lookupAnime(bgmId, title);
    return anime?.status === "FINISHED" ? anime : null;
  }
  async function lookupAnime(bgmId, title) {
    if (
      !/^\d{1,8}$/.test(String(bgmId)) ||
      typeof title !== "string" ||
      !title.trim()
    )
      return null;
    const found = await animeCatalog.search({ query: title.slice(0, 100) });
    return found.items.find((i) => i.bgmId === String(bgmId)) || null;
  }

  let migrationPlan = null;
  const accountFile = path.join(
    path.dirname(configFile),
    "data/anibt-account.json",
  );
  let websiteChange;
  const episodePlans = new Map(),
    showPlans = new Map(),
    gapAudits = new Map();
  const trackingFile = path.join(
    path.dirname(configFile),
    "data/tracking.json",
  );
  const readTracking = () => readJsonFile(trackingFile, {});
  const operations = watchedOperations(configFile);
  let recoveryNextAt = 0;
  const requireRecovered = () => {
    if (operations.pending().length)
      throw new Error(
        "有删除操作尚待恢复，请先在上方核对并恢复记录；不要重复删除或重新下载。",
      );
  };
  async function finishWatched(
    input,
    targets,
    qb,
    c,
    state,
    tracking,
    previousResult,
  ) {
    let op;
    try {
      op = operations.prepare({ ...input, targets });
    } catch {
      throw new Error("无法保存删除操作意图，尚未向下载器发送删除请求。");
    }
    let confirmed = false,
      active = [];
    try {
      if (targets.length) {
        await qb.request(
          "torrents/delete",
          new URLSearchParams({
            hashes: targets.map((t) => t.hash).join("|"),
            deleteFiles: "true",
          }),
        );
        let remaining = true;
        for (let n = 0; n < 10; n++) {
          active = await qb.list();
          remaining = active.some((t) =>
            targets.some((x) => x.hash === t.hash?.toLowerCase()),
          );
          if (!remaining) break;
          await sleep(300);
        }
        if (remaining) throw new Error("删除结果待核对");
      }
      confirmed = true;
      let result =
        !targets.length && previousResult
          ? {
              removedTasks: 0,
              filesRemaining: previousResult.filesRemaining || 0,
              unknownFiles: previousResult.unknownFiles || 0,
              folderErrors: previousResult.folderErrors || 0,
            }
          : finishDeletion(op, active);
      // qB may remove the task before its asynchronous file cleanup reaches disk.
      for (
        let retries = 0;
        targets.length &&
        op.cleanupFolders?.length &&
        result.filesRemaining &&
        retries < 5;
        retries++
      ) {
        await sleep(350);
        active = await qb.list();
        result = finishDeletion(op, active);
      }
      op = operations.complete(op, result);
      const outcome = commitWatchedOperation(op, {
        config: c,
        configFile,
        state,
        tracking,
        write: deps.writeWatchedFile || atomicWrite,
      });
      operations.committed(op);
      return outcome;
    } catch (error) {
      const message = confirmed
        ? "下载器已完成，本地记录待恢复"
        : "删除请求可能已执行，结果待核对";
      record(message, "warning");
      throw Object.assign(
        new Error(
          message + "。操作意图已保存，请使用“核对并恢复记录”，不要重复删除。",
        ),
        { status: 503 },
      );
    }
  }
  async function recoverWatched() {
    requireIdle({ recovery: true });
    const pending = operations.pending();
    if (!pending.length && !stateStore.pending().length)
      return { restored: 0, remaining: [] };
    busy = "recover-watched";
    const wasRunning = bg().running;
    let release,
      qb,
      restored = 0;
    try {
      if (wasRunning) await script("stop");
      const c = getConfig();
      release = lock(statePath(c, configFile) + ".lock");
      restored += stateStore.recover();
      for (let op of pending) {
        if (op.status === "prepared") {
          let result;
          if (!op.targets.length) result = deletionResult([]);
          else {
            if (!qb) {
              qb = deps.episodeQb || new QbClient(c);
              await qb.login();
            }
            result = await verifyDeletion(op, qb);
          }
          if (!result) continue;
          op = operations.complete(op, result);
        }
        commitWatchedOperation(op, {
          config: c,
          configFile,
          state: loadState(
            statePath(c, configFile),
            c,
            Object.values(readManual()),
          ),
          tracking: readTracking(),
          write: deps.writeWatchedFile || atomicWrite,
        });
        operations.committed(op);
        restored++;
      }
      return { restored, remaining: operations.summary() };
    } finally {
      try {
        await qb?.logout();
      } catch {}
      release?.();
      busy = null;
      feedCache = null;
      qbCache = null;
      if (wasRunning && !stateStore.pending().length) await script("start");
    }
  }

  const trackedKey = (tracking, key, c = getConfig()) => {
    if (Object.hasOwn(tracking, key)) return key;
    const state = loadState(
      statePath(c, configFile),
      c,
      Object.values(readManual()),
    );
    const evidence = [
      ...(feedCache?.items || []),
      ...Object.values(state.done),
      ...Object.values(readManual()),
      ...Object.values(tracking).map((t) => ({ ...t, animeTitle: t.title })),
    ];
    return Object.keys(tracking).find(
      (k) =>
        animeKey(
          applyAnimeBindings(
            [{ animeTitle: tracking[k].title, bgmId: tracking[k].bgmId || "" }],
            c,
            evidence,
          )[0],
        ) === key,
    );
  };
  const manualFile = path.join(
    path.dirname(configFile),
    "data/manual-downloads.json",
  );
  const readManual = () => {
    try {
      const data = JSON.parse(fs.readFileSync(manualFile, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw new Error(
        "手动下载记录无法读取，请先检查 data/manual-downloads.json。",
      );
    }
  };
  const events = [];
  const getConfig = () => loadConfig(configFile);
  const revision = () =>
    fs.existsSync(configFile) ? fs.statSync(configFile).mtimeMs : 0;
  const record = (message, kind = "info") => {
    events.unshift({ time: new Date().toISOString(), message, kind });
    if (events.length > 40) events.pop();
  };
  const readFeed = async (force = false) => {
    const c = getConfig(),
      key = digest(c) + ":" + revision();
    if (activeFeedKey !== key) {
      activeFeedKey = key;
      feedGeneration++;
    }
    const generation = feedGeneration,
      flightKey = key + ":" + generation;
    if (
      !force &&
      feedCache?.key === key &&
      feedCache.generation === generation &&
      Date.now() - feedCache.at < 60000
    )
      return feedCache.items;
    if (feedPromises.has(flightKey)) return feedPromises.get(flightKey);
    const promise = Promise.resolve()
      .then(() => (deps.fetchFeed || fetchFeed)(c.rssUrl))
      .then((raw) => {
        if (
          digest(getConfig()) + ":" + revision() !== key ||
          generation !== feedGeneration
        )
          throw Object.assign(new Error("订阅配置已变化，请重新读取。"), {
            status: 409,
          });
        const items = applyAnimeBindings(raw, c);
        feedCache = { key, generation, at: Date.now(), items };
        try {
          noteFeedSuccess(configFile, {
            previousAt:
              readJsonFile(statePath(c, configFile), {}).updatedAt || "",
          });
        } catch {}
        return items;
      })
      .finally(() => {
        if (feedPromises.get(flightKey) === promise)
          feedPromises.delete(flightKey);
      });
    feedPromises.set(flightKey, promise);
    return promise;
  };
  const bg = () =>
    deps.backgroundStatus
      ? deps.backgroundStatus()
      : backgroundStatus(configFile);
  const script = (action) =>
    deps.executeScript ? deps.executeScript(action) : executeScript(action);
  const qbSnapshot = async (force = false) => {
    if (qbPromise) return qbPromise;
    if (!force && qbCache && Date.now() - qbCache.at < 15000) return qbCache;
    qbPromise = readQbSnapshot().finally(() => (qbPromise = null));
    return qbPromise;
  };
  const qbInfo = async (force = false) => (await qbSnapshot(force)).value;
  const readQbSnapshot = async () => {
    const c = getConfig();
    const qb = deps.qb || new QbClient(c);
    let value;
    let taskHashes = new Set(),
      taskFolders = [];
    try {
      const version = await qb.login();
      const [all, prefs] = await Promise.all([
        qb.list(),
        qb.request("app/preferences").then((r) => r.json()),
      ]);
      const state = loadState(
        statePath(c, configFile),
        c,
        Object.values(readManual()),
      );
      const hashes = new Set(
        [
          ...Object.values(state.done).map((x) => x.hash),
          ...Object.keys(readManual()),
        ].filter(Boolean),
      );
      const torrents = all
        .filter(
          (t) =>
            (c.qb.category && t.category === c.qb.category) ||
            hashes.has(t.hash),
        )
        .map((t) => ({
          name: t.name,
          hash: t.hash,
          progress: t.progress,
          size: t.size || t.total_size,
          downloadSpeed: t.dlspeed,
          uploadSpeed: t.upspeed,
          state: t.state,
          eta: t.eta,
          savePath: t.save_path,
        }));
      value = {
        connected: true,
        version,
        savePath: c.qb.savePath || prefs.save_path,
        torrents,
      };
      taskHashes = new Set(
        all.flatMap((t) =>
          typeof t.hash === "string" ? [t.hash.toLowerCase()] : [],
        ),
      );
      taskFolders = all.map((t) => ({
        hash: t.hash,
        save_path: t.save_path,
        content_path: t.content_path,
      }));
    } catch (e) {
      value = { connected: false, error: e.message, torrents: [] };
    } finally {
      await qb.logout();
    }
    qbCache = { at: Date.now(), value, taskHashes, taskFolders };
    return qbCache;
  };
  const requireIdle = ({ recovery = false } = {}) => {
    if (!recovery) stateStore.assertClean();
    if (busy)
      throw Object.assign(new Error("正在执行另一项操作，请稍候。"), {
        status: 409,
      });
  };
  const readAccount = () => {
    try {
      return JSON.parse(fs.readFileSync(accountFile, "utf8"));
    } catch {
      return null;
    }
  };
  async function finishWebsiteChange(input) {
    if (!websiteChange || websiteChange.id !== input.changeId)
      throw new Error("订阅操作已结束，请刷新网站状态。");
    const change = websiteChange;
    websiteChange = null;
    clearTimeout(change.timer);
    try {
      const c = getConfig(),
        control = readAniBTControl(configFile, c),
        verified = input.verified === true;
      if (change.action === "unsubscribe") {
        if (verified && input.subscribed === false) {
          control.blocked[change.bgmId] = true;
          control.unsubscribed[change.bgmId] = true;
          const state = loadState(
            statePath(c, configFile),
            c,
            Object.values(readManual()),
          );
          for (const [id, pending] of Object.entries(state.pending))
            if (
              String(pending.item?.bgmId) === change.bgmId &&
              pending.source === sourceKey(c.rssUrl)
            )
              delete state.pending[id];
          atomicWrite(statePath(c, configFile), state);
        } else if (verified && input.subscribed === true) {
          delete control.unsubscribed[change.bgmId];
          if (!change.beforeBlocked) delete control.blocked[change.bgmId];
        } else if (!verified) control.blocked[change.bgmId] = true;
      } else if (verified && input.subscribed === true) {
        // Set the date while the watcher is still stopped. Explicit user dates always win.
        if (!change.wasSubscribed && input.existing !== true) {
          const existing = matchingAnimeRule(
            { bgmId: change.bgmId, animeTitle: change.title },
            c,
          );
          const filters = effectiveFilters(
              { bgmId: change.bgmId, animeTitle: change.title },
              c,
            ),
            onlyEpisode =
              Number.isInteger(filters.startEpisode) && !filters.startDate;
          if (
            !onlyEpisode &&
            (!existing ||
              !Object.hasOwn(existing, "startDate") ||
              existing.startDateFromSubscription === existing.startDate)
          ) {
            const date = beijingDate(deps.now ? deps.now() : new Date());
            if (!date) throw new Error("无法确认订阅日期，请检查系统时间。");
            const rule = existing?.bgmId
              ? existing
              : {
                  ...(existing || {}),
                  bgmId: change.bgmId,
                  ...(change.title ? { title: change.title } : {}),
                };
            if (rule !== existing) c.rules.unshift(rule);
            rule.startDate = date;
            rule.startDateFromSubscription = date;
            validateConfig(c);
            atomicWrite(configFile, c);
          }
        }
        delete control.blocked[change.bgmId];
        delete control.unsubscribed[change.bgmId];
      }
      saveAniBTControl(configFile, control);
      feedCache = null;
      record(
        verified ? "网站订阅状态已同步" : "网站结果尚待核对，请刷新订阅列表",
        verified ? "success" : "warning",
      );
      return { ok: true };
    } finally {
      change.release?.();
      busy = null;
      if (change.wasRunning) await script("start");
    }
  }
  async function downloadMutation(kind, run, client) {
    requireIdle();
    requireRecovered();
    busy = kind;
    const wasRunning = bg().running;
    let release, qb;
    try {
      if (wasRunning) await script("stop");
      const c = getConfig();
      release = lock(statePath(c, configFile) + ".lock");
      qb =
        client ||
        deps.episodeQb ||
        deps.reprocessQb ||
        deps.manualQb ||
        new QbClient(c);
      await (qb.connectForDownload ? qb.connectForDownload() : qb.login());
      return await run(qb, c);
    } finally {
      try {
        await qb?.logout();
      } catch {
        record("下载器会话退出失败，操作结果请以记录为准。", "warning");
      }
      release?.();
      busy = null;
      feedCache = null;
      qbCache = null;
      if (wasRunning)
        try {
          await script("start");
        } catch {
          record("自动追番暂未恢复，请点击启动。", "warning");
        }
    }
  }
  const historyDisplayFile = path.join(
    path.dirname(configFile),
    "data/history-display.json",
  );
  const allHistory = (state, manual) =>
    [
      ...Object.entries(state.done)
        .filter(([, x]) => x.status !== "episode-duplicate")
        .map(([id, x]) => ({ id, ...x })),
      ...Object.entries(manual).map(([id, x]) => ({ id, ...x })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  const historyKey = (x) => JSON.stringify([x.kind || "automatic", x.id, x.at]);
  const hiddenHistory = () => {
    try {
      const value = JSON.parse(fs.readFileSync(historyDisplayFile, "utf8"));
      if (
        !Array.isArray(value.hidden) ||
        value.hidden.some((x) => typeof x !== "string")
      )
        throw new Error();
      return new Set(value.hidden);
    } catch (e) {
      if (e.code === "ENOENT") return new Set();
      throw new Error(
        "历史记录显示设置无法读取，请检查 data/history-display.json。",
      );
    }
  };
  async function action(input) {
    requireIdle();
    const allowed = [
      "check",
      "backfill",
      "start",
      "stop",
      "autostart-on",
      "autostart-off",
    ];
    if (!allowed.includes(input.action)) throw new Error("未知操作。");
    if (input.action === "backfill" && input.confirm !== true)
      throw new Error("请先预览并确认补下载范围。");
    const selectedIds =
      input.action === "backfill"
        ? normalizeBackfillSelection(input.selectedIds)
        : undefined;
    busy = input.action;
    try {
      if (
        ["start", "stop", "autostart-on", "autostart-off"].includes(
          input.action,
        )
      ) {
        const name = {
          start: "start",
          stop: "stop",
          "autostart-on": "install",
          "autostart-off": "uninstall",
        }[input.action];
        await script(name);
        record(
          {
            start: "自动追番已启动",
            stop: "自动追番已暂停",
            "autostart-on": "已开启登录自动启动",
            "autostart-off": "已关闭登录自动启动",
          }[input.action],
        );
        return { ok: true, background: bg() };
      }
      const wasRunning = bg().running;
      if (wasRunning) await script("stop");
      let release;
      try {
        const c = getConfig();
        release = lock(statePath(c, configFile) + ".lock");
        const report = await runOnce(
          c,
          configFile,
          {
            backfill: input.action === "backfill",
            ...(selectedIds ? { selectedIds } : {}),
          },
          { ...(deps.runner || {}), log: (message) => record(message) },
        );
        record(
          `检查完成：新增 ${report.added}，已处理 ${report.existing}，待重试 ${report.failed}`,
          report.failed ? "warning" : "success",
        );
        feedCache = null;
        qbCache = null;
        return { ok: true, report };
      } finally {
        release?.();
        if (wasRunning) await script("start");
      }
    } catch (e) {
      record(e.message, "error");
      throw e;
    } finally {
      busy = null;
    }
  }
  function json(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  const updateFile = path.join(
    path.dirname(configFile),
    "data/library-tools.json",
  );
  const updateNetwork = deps.updateNetwork || createSourceNetwork(preferences);
  const releaseChecker = createReleaseChecker({
    read: () => readJsonFile(updateFile, {}),
    write: (value) => atomicWrite(updateFile, value),
    network: updateNetwork,
  });
  const portableUpdater = createPortableUpdater({
    root,
    configFile,
    network: updateNetwork,
    releaseChecker,
  });

  const serviceContext = {
    root,
    get stateStore() {
      return stateStore;
    },
    get json() {
      return json;
    },
    get animeCatalog() {
      return animeCatalog;
    },
    get getConfig() {
      return getConfig;
    },
    get readAccount() {
      return readAccount;
    },
    get requireIdle() {
      return requireIdle;
    },
    get atomicWrite() {
      return atomicWrite;
    },
    get accountFile() {
      return accountFile;
    },
    get busy() {
      return busy;
    },
    set busy(value) {
      busy = value;
    },
    get bg() {
      return bg;
    },
    get script() {
      return script;
    },
    get configFile() {
      return configFile;
    },
    get websiteChange() {
      return websiteChange;
    },
    set websiteChange(value) {
      websiteChange = value;
    },
    get finishWebsiteChange() {
      return finishWebsiteChange;
    },
    get record() {
      return record;
    },
    get artwork() {
      return artwork;
    },
    get readFeed() {
      return readFeed;
    },
    get describeItems() {
      return describeItems;
    },
    get readManual() {
      return readManual;
    },
    get readTracking() {
      return readTracking;
    },
    get feedCache() {
      return feedCache;
    },
    set feedCache(value) {
      feedCache = value;
    },
    get animeGroupCache() {
      return animeGroupCache;
    },
    get deps() {
      return deps;
    },
    get groupCache() {
      return groupCache;
    },
    set groupCache(value) {
      groupCache = value;
    },
    get preferences() {
      return preferences;
    },
    get events() {
      return events;
    },
    get qbCache() {
      return qbCache;
    },
    set qbCache(value) {
      qbCache = value;
    },
    get preferenceDefaults() {
      return preferenceDefaults;
    },
    get preferencesFile() {
      return preferencesFile;
    },
    get applyConfigPatch() {
      return applyConfigPatch;
    },
    get revision() {
      return revision;
    },
    get publicConfig() {
      return publicConfig;
    },
    get allHistory() {
      return allHistory;
    },
    get historyDisplayFile() {
      return historyDisplayFile;
    },
    get historyKey() {
      return historyKey;
    },
    get qbInfo() {
      return qbInfo;
    },
    get qbSnapshot() {
      return qbSnapshot;
    },
    async discoveryTaskPresence(hashes, force) {
      const snapshot = await qbSnapshot(force);
      return {
        connected: snapshot.value.connected,
        hashes: hashes.filter((hash) => snapshot.taskHashes.has(hash)),
      };
    },
    get readJsonFile() {
      return readJsonFile;
    },
    get downloadMutation() {
      return downloadMutation;
    },
    get manualFile() {
      return manualFile;
    },
    get animeResources() {
      return animeResources;
    },
    get fallbackResources() {
      return fallbackResources;
    },
    get lookupAnime() {
      return lookupAnime;
    },
    get completedAnime() {
      return completedAnime;
    },
    get discovery() {
      return discovery;
    },
    get discoveryAssociation() {
      return discoveryAssociation;
    },
    get requireRecovered() {
      return requireRecovered;
    },
    get migrationPlan() {
      return migrationPlan;
    },
    set migrationPlan(value) {
      migrationPlan = value;
    },
    get trackingFile() {
      return trackingFile;
    },
    get trackedKey() {
      return trackedKey;
    },
    get showPlans() {
      return showPlans;
    },
    get finishWatched() {
      return finishWatched;
    },
    get episodePlans() {
      return episodePlans;
    },
    get recoverWatched() {
      return recoverWatched;
    },
  };
  const domainRoutes = [
    createSubscriptionRoutes(serviceContext),
    createSettingsRoutes(serviceContext),
    createDownloadRoutes(serviceContext),
    createBackupRoutes(serviceContext),
    createProgressRoutes(serviceContext),
  ];

  const handler = async (req, res) => {
    const host = req.headers.host;
    if (
      !/^127\.0\.0\.1:\d+$/.test(host || "") ||
      host !== `127.0.0.1:${req.socket.localPort}`
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://r2.anibt.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const u = new URL(req.url, `http://${host}`);
    if (req.method === "GET" && /^\/covers\/[a-f0-9]{32}$/.test(u.pathname)) {
      try {
        const item = await artwork.get(u.pathname.slice(8));
        res.writeHead(200, {
          "Content-Type": item.mime,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private,max-age=86400",
        });
        res.end(item.bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (!u.pathname.startsWith("/api/")) {
      const asset = assets.get(u.pathname);
      if (req.method !== "GET" || !asset) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const { name } = asset,
          mime = name.endsWith(".html")
            ? "text/html"
            : name.endsWith(".js")
              ? "text/javascript"
              : name.endsWith(".svg")
                ? "image/svg+xml"
                : name.endsWith(".webp")
                  ? "image/webp"
                  : "text/css";
        let { content } = asset;
        if (name === "index.html")
          content = content
            .toString("utf8")
            .replaceAll("__APP_VERSION__", APP_VERSION)
            .replace(
              '<html lang="zh-CN">',
              `<html lang="zh-CN" data-theme-preference="${preferences().theme}" data-design="${preferences().design}">`,
            );
        res.writeHead(200, {
          "Content-Type": mime.startsWith("image/")
            ? mime
            : mime + "; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    const provided = Buffer.from(String(req.headers["x-app-token"] || ""));
    const expected = Buffer.from(token);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      json(res, 403, { error: "此窗口的访问凭据已失效，请重新打开图形界面。" });
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      json(res, 403, { error: "请求来源不受支持。" });
      return;
    }
    try {
      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (
            size >
            (u.pathname === "/api/backup/preview"
              ? 16777216
              : ["/api/progress/review", "/api/progress/review/draft"].includes(
                    u.pathname,
                  )
                ? 131072
                : 65536)
          )
            throw new Error("提交内容过大。");
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          throw new Error("提交格式不正确。");
        }
      }
      const route = req.method + " " + u.pathname;
      for (const handle of domainRoutes)
        if ((await handle({ route, req, res, body, u })) !== false) return;

      if (route === "POST /api/window") {
        if (
          !/^[a-f0-9]{32}$/.test(body.windowId || "") ||
          !["open", "close"].includes(body.action)
        )
          throw new Error("窗口标识无效。");
        clearTimeout(idleTimer);
        if (body.action === "open") windows.add(body.windowId);
        else windows.delete(body.windowId);
        if (!windows.size && body.action === "close" && deps.onIdle) {
          const check = () => {
            if (windows.size) return;
            if (busy) {
              idleTimer = setTimeout(check, 1000);
              idleTimer.unref?.();
              return;
            }
            deps.onIdle();
          };
          idleTimer = setTimeout(check, deps.idleMs ?? 30000);
          idleTimer.unref?.();
        }
        json(res, 200, { ok: true });
        return;
      }
      if (route === "POST /api/notifications/test") {
        await (deps.notifyNative || nativeNotification)([
          "--notify",
          "AniBT 通知已接通",
          "下载完成后会在这里提醒你。",
          "test",
        ]);
        json(res, 200, { ok: true });
        return;
      }
      if (route === "GET /api/ping") {
        json(res, 200, {
          app: "anibt-qb-gui",
          version: APP_VERSION,
          capabilities: {
            perItemRetries: true,
            manualEpisodeLedger: true,
            strictBackup: true,
            sourceScopedFeed: true,
            healthSupervision: true,
            reviewDrafts: true,
            automaticBackups: true,
            watchedFilters: true,
            offlineReconcile: true,
            watchSessions: true,
            diagnostics: true,
            releaseChecks: true,
            seasonCatchup: true,
            historyShortcuts: true,
            discoveryAnimeFolders: true,
            externalSubtitleLink: true,
            animeCovers: true,
            overviewDetails: true,
            monthlyCleanup: true,
            selectiveBackfill: true,
            historyVisibility: true,
            animeFolders: true,
            startDate: true,
            startEpisode: true,
            restoreDefaults: true,
            reprocessDownloads: true,
            animeResourceBrowser: true,
            websiteSubscriptions: true,
            seasonTimeline: true,
            priorityWait: true,
            progress: true,
            rulePreview: true,
            backupMigration: true,
            downloadAlerts: true,
          },
        });
        return;
      }
      if (route === "GET /api/interface-state") {
        json(
          res,
          200,
          readInterfaceState(path.join(path.dirname(configFile), "data")),
        );
        return;
      }
      if (route === "POST /api/interface-state") {
        json(
          res,
          200,
          patchInterfaceState(
            path.join(path.dirname(configFile), "data"),
            body,
          ),
        );
        return;
      }

      if (route === "GET /api/notifications") {
        json(
          res,
          200,
          notificationHistory(path.join(path.dirname(configFile), "data")),
        );
        return;
      }
      if (route === "POST /api/notifications/read") {
        json(
          res,
          200,
          markNotificationsRead(
            path.join(path.dirname(configFile), "data"),
            body.ids,
          ),
        );
        return;
      }
      if (route === "GET /api/help") {
        json(res, 200, {
          text: fs.readFileSync(path.join(root, "使用说明.md"), "utf8"),
        });
        return;
      }

      if (route === "GET /api/library/snapshots") {
        json(res, 200, { items: snapshots.list() });
        return;
      }
      if (route === "POST /api/library/snapshot/preview") {
        requireIdle();
        json(res, 200, snapshots.preview(body.id));
        return;
      }
      if (
        route === "POST /api/library/snapshot/create" ||
        route === "POST /api/library/snapshot/restore"
      ) {
        requireIdle();
        requireRecovered();
        const restore = route.endsWith("/restore");
        if (restore && body.confirm !== true)
          throw Error("请预览并确认恢复范围。");
        busy = "local-snapshot";
        let release;
        const wasRunning = bg().running;
        try {
          if (wasRunning) await script("stop");
          const c = getConfig();
          release = lock(statePath(c, configFile) + ".lock");
          const result = restore
            ? snapshots.restore(body.id, stateStore)
            : snapshots.create(stateStore);
          feedCache = null;
          qbCache = null;
          json(res, 200, result);
        } finally {
          release?.();
          busy = null;
          if (wasRunning && !restore && !stateStore.pending().length)
            await script("start");
        }
        return;
      }
      if (route === "GET /api/library/status") {
        json(res, 200, {
          backup: backupSettings(configFile),
          backups: listAutomaticBackups(configFile),
          continuity: continuityStatus(configFile),
          version: APP_VERSION,
          repository: releaseChecker.settings().repository,
          repositoryOverride: releaseChecker.settings().override,
          installer: portableUpdater.status(),
        });
        return;
      }
      if (route === "POST /api/library/backup/settings") {
        json(res, 200, setBackupSettings(configFile, body));
        return;
      }
      if (route === "POST /api/library/backup") {
        requireIdle();
        const result = maybeAutomaticBackup(configFile, { force: true });
        json(res, 200, {
          ...result,
          backups: listAutomaticBackups(configFile),
        });
        return;
      }
      if (route === "GET /api/library/backup") {
        json(
          res,
          200,
          readAutomaticBackup(configFile, u.searchParams.get("id")),
        );
        return;
      }
      if (route === "POST /api/library/update-source") {
        const { repository, override } = releaseChecker.setRepository(
          body.repository,
        );
        json(res, 200, { repository, override });
        return;
      }
      if (route === "POST /api/library/check-update") {
        json(res, 200, {
          ...(await releaseChecker.check({ force: body.automatic !== true })),
          installer: portableUpdater.status(),
        });
        return;
      }
      if (route === "POST /api/library/install-update") {
        requireIdle();
        if (body.confirm !== true) throw new Error("请先确认安装程序更新。");
        busy = "program-update";
        try {
          json(res, 200, await portableUpdater.prepare(body.version));
        } finally {
          busy = null;
        }
        return;
      }
      if (route === "GET /api/library/diagnostics") {
        let c,
          configValid = true,
          stateReadable = true,
          trackingReadable = true,
          state,
          tracking,
          qb,
          backup,
          continuity;
        try {
          c = getConfig();
        } catch {
          configValid = false;
          try {
            c = loadConfig(configFile, { validate: false });
          } catch {
            c = clone(defaults);
          }
        }
        try {
          state = loadState(
            statePath(c, configFile),
            c,
            Object.values(readManual()),
          );
          if (!state.done || !state.pending) throw new Error();
        } catch {
          stateReadable = false;
          state = { done: {}, pending: {} };
        }
        try {
          tracking = readTracking();
          if (
            !tracking ||
            typeof tracking !== "object" ||
            Array.isArray(tracking) ||
            Object.values(tracking).some(
              (t) => !t || typeof t !== "object" || Array.isArray(t),
            )
          )
            throw new Error();
        } catch {
          trackingReadable = false;
          tracking = {};
        }
        try {
          qb = await qbInfo(false);
        } catch {
          qb = { connected: false };
        }
        try {
          backup = backupSettings(configFile);
        } catch {
          backup = { enabled: false, keep: 0, lastError: "invalid" };
        }
        try {
          continuity = continuityStatus(configFile);
        } catch {
          continuity = { lastSuccessAt: "", needsCheck: false };
        }
        json(res, 200, {
          configValid,
          stateReadable,
          trackingReadable,
          appVersion: APP_VERSION,
          generatedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          watcherRunning: !!bg().running,
          qbConnected: !!qb.connected,
          rssConfigured: !!c.rssUrl,
          qbAutoStart: !!c.qb.autoStart,
          networkMode: preferences().networkMode,
          persistence: {
            pendingTransactions: stateStore.summary().length,
            localSnapshots: snapshots.list().length,
            stateBytes: !stateReadable
              ? 0
              : (() => {
                  try {
                    return fs.statSync(statePath(c, configFile)).size;
                  } catch {
                    return 0;
                  }
                })(),
            historyArchiveRecommended: Object.keys(state.done).length >= 10000,
          },
          counts: {
            trackedShows: Object.keys(tracking).length,
            watchedShows: Object.values(tracking).filter((t) => t.completedAt)
              .length,
            reviews: Object.values(tracking).reduce(
              (n, t) =>
                n +
                (t?.personalReview ? 1 : 0) +
                (Array.isArray(t?.watchSessions)
                  ? t.watchSessions.filter((s) => s.personalReview).length
                  : 0),
              0,
            ),
            pastWatches: Object.values(tracking).reduce(
              (n, t) =>
                n +
                (Array.isArray(t?.watchSessions) ? t.watchSessions.length : 0),
              0,
            ),
            drafts: Object.keys(readDrafts(configFile)).length,
            pending: Object.keys(state.pending).length,
            records: Object.keys(state.done).length,
          },
          backup: {
            enabled: backup.enabled,
            keep: backup.keep,
            lastAt: backup.lastAt || "",
            hasError: !!backup.lastError,
          },
          continuity: {
            lastSuccessAt: continuity.lastSuccessAt,
            needsCheck: !!continuity.needsCheck,
            gapHours: continuity.gapHours || 0,
          },
        });
        return;
      }

      if (route === "POST /api/library/gaps/ack") {
        json(res, 200, acknowledgeContinuity(configFile));
        return;
      }
      if (route === "POST /api/library/gaps/check") {
        const c = getConfig(),
          state = loadState(
            statePath(c, configFile),
            c,
            Object.values(readManual()),
          ),
          manual = readManual(),
          tracking = readTracking();
        let audit = body.auditId && gapAudits.get(body.auditId);
        if (!body.auditId) {
          const items = await readFeed(true),
            shows = buildProgress({
              items,
              state,
              manual,
              tracking,
              config: c,
            }).filter((t) => !t.archived && !t.completedAt);
          const id = randomBytes(16).toString("hex");
          audit = { id, shows, at: Date.now() };
          gapAudits.set(id, audit);
          for (const [key, a] of gapAudits)
            if (Date.now() - a.at > 1800000) gapAudits.delete(key);
          while (gapAudits.size > 10)
            gapAudits.delete(gapAudits.keys().next().value);
        }
        if (!audit || Date.now() - audit.at > 1800000)
          throw new Error("核对任务已过期，请重新开始。");
        const offset = body.offset || 0;
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > audit.shows.length
        )
          throw new Error("核对范围无效。");
        const shows = audit.shows.slice(offset, offset + 5),
          history = applyAnimeBindings(
            [...Object.values(state.done), ...Object.values(manual)],
            c,
          );
        const results = await Promise.all(
          shows.map(async (show) => {
            if (!show.bgmId)
              return {
                title: show.title,
                error: "缺少准确番剧编号，未自动核对。",
                items: [],
              };
            try {
              const list = await animeResources.list({
                  bgmId: show.bgmId,
                  refresh: true,
                }),
                recorded = new Set(
                  history
                    .filter(
                      (i) =>
                        animeKey(i) === show.key &&
                        ["added", "existing"].includes(i.status),
                    )
                    .map((i) => episodeNumber(i.episode))
                    .filter(Boolean),
                );
              const ids = new Set(
                catchupRecommendations(
                  list.items,
                  c,
                  tracking,
                  (i) => {
                    const ep = episodeNumber(i.episode);
                    return (
                      recorded.has(ep) ||
                      !!episodeRecorded(state, i) ||
                      ep < (show.startEpisode || 1) ||
                      (Object.hasOwn(show.episodeStates || {}, String(ep))
                        ? show.episodeStates[ep] === true
                        : ep <= (show.watched || 0))
                    );
                  },
                  "normal",
                ),
              );
              const rows = describeItems(list.items, c, state, {}, tracking)
                .map((row, i) => ({ ...row, resultId: list.items[i].resultId }))
                .filter((r) => ids.has(r.resultId));
              return {
                title: show.title,
                bgmId: show.bgmId,
                items: rows,
                readCount: list.items.length,
                possiblyLimited: !!list.possiblyLimited,
              };
            } catch {
              return {
                title: show.title,
                error: "公开 RSS 暂时无法读取，可稍后重试。",
                items: [],
              };
            }
          }),
        );
        json(res, 200, {
          auditId: audit.id,
          total: audit.shows.length,
          nextOffset: offset + shows.length,
          done: offset + shows.length >= audit.shows.length,
          results,
        });
        return;
      }

      if (route === "GET /api/status") {
        if (Date.now() >= recoveryNextAt && !busy) {
          recoveryNextAt = Date.now() + 30000;
          void recoverWatched().catch(() =>
            record("本地操作恢复尚未完成，请在界面核对并重试。", "warning"),
          );
        }
        let c, error;
        try {
          c = getConfig();
        } catch (e) {
          error = fs.existsSync(configFile)
            ? e.message
            : "欢迎使用！请先填写你自己的 AniBT 私人 RSS 和 qBittorrent 连接信息，再保存设置。";
          c = clone(defaults);
        }
        const state = error
          ? { done: {}, pending: {}, episodes: {}, sources: {} }
          : loadState(statePath(c, configFile), c, Object.values(readManual()));
        const manual = readManual();
        const directory = path.join(path.dirname(configFile), "data");
        if (!busy) {
          const cleanup = runMonthlyCleanup(directory);
          if (cleanup.ran) {
            events.length = 0;
            feedCache = null;
            qbCache = null;
          }
        }
        const maintenance = maintenanceStatus(directory);
        const hidden = hiddenHistory(),
          history = allHistory(state, manual).filter((row) =>
            afterCleanup(row, maintenance),
          ),
          visible = history.filter((x) => !hidden.has(historyKey(x)));
        json(res, 200, {
          config: publicConfig(c),
          revision: revision(),
          configurationError: error,
          busy,
          watchedOperations: operations.summary(),
          localTransactions: stateStore.summary(),
          retryQueue: overviewDetails(state, c, { kind: "pending", page: "1" })
            .items,
          background: bg(),
          preferences: preferences(),
          notifications: notificationHistory(
            path.join(path.dirname(configFile), "data"),
          ),
          maintenance,
          state: {
            updatedAt: state.updatedAt,
            initialized: !!state.sources[sourceKey(c.rssUrl)],
            added: Object.values(state.done).filter(
              (x) => x.status === "added" && afterCleanup(x, maintenance),
            ).length,
            episodes: Object.keys(state.episodes).length,
            pending: Object.keys(state.pending).length,
            history: visible.slice(0, 80).map((row) => ({
              ...row,
              reprocessKey: historyKey(row),
              canReprocess: /^[a-f0-9]{40}$/i.test(row.hash || ""),
            })),
            historyCount: visible.length,
            historyHidden: history.length - visible.length,
          },
          events,
        });
        return;
      }
      if (route === "GET /api/overview/details") {
        const c = getConfig(),
          state = loadState(
            statePath(c, configFile),
            c,
            Object.values(readManual()),
          );
        json(
          res,
          200,
          overviewDetails(
            state,
            c,
            {
              kind: u.searchParams.get("kind"),
              query: u.searchParams.get("q") || "",
              page: u.searchParams.get("page") || "1",
            },
            readAniBTControl(configFile, c),
            readMaintenance(path.join(path.dirname(configFile), "data")),
          ),
        );
        return;
      }

      if (route === "GET /api/qb") {
        json(res, 200, await qbInfo(u.searchParams.get("refresh") === "1"));
        return;
      }
      if (route === "GET /api/logs") {
        const d = path.join(path.dirname(configFile), "data");
        json(res, 200, {
          lines: tail(path.join(d, "watch.log")),
          errors: tail(path.join(d, "watch-error.log")),
        });
        return;
      }

      if (route === "POST /api/action") {
        json(res, 200, await action(body));
        return;
      }
      json(res, 404, { error: "没有找到此功能。" });
    } catch (e) {
      json(res, e.status || 400, { error: e.message });
    }
  };
  return { handler, token };
}
export function openWindow(url) {
  const native = path.join(root, "native/AniBT.exe");
  if (process.platform === "win32" && fs.existsSync(native)) {
    const child = spawn(native, [url], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return;
  }
  const edgePaths = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((p) => path.join(p, "Microsoft/Edge/Application/msedge.exe"));
  const edge = edgePaths.find((p) => fs.existsSync(p));
  if (edge) {
    const child = spawn(edge, [`--app=${url}`, "--window-size=1360,900"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  } else {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }
}
export async function startGui({
  configFile = path.join(root, "config.json"),
  open = true,
  background = false,
} = {}) {
  if (path.resolve(configFile) === path.join(root, "config.json"))
    await guardPortableUpdate(root);
  const windowPath = background ? "/?background=1&page=downloads" : "/";
  const directory = path.join(path.dirname(configFile), "data");
  const descriptor = path.join(directory, "gui.json");
  const lockFile = path.join(directory, "gui.lock");
  let existing;
  try {
    const info = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { "X-App-Token": info.token },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      const ping = await r.json();
      if (ping.app === "anibt-qb-gui")
        existing = { ...info, version: ping.version };
    }
  } catch {}
  if (existing?.version === APP_VERSION) {
    if (open)
      openWindow(
        `http://127.0.0.1:${existing.port}${windowPath}#token=${existing.token}`,
      );
    return;
  }
  if (existing) {
    // Closing the last window lets the old process finish any active operation and exit on its own.
    if (open && !background) {
      const deadline = Date.now() + 32000;
      while (fs.existsSync(lockFile) && Date.now() < deadline) await sleep(250);
    }
    if (fs.existsSync(lockFile))
      throw new Error(
        "另一个版本的 AniBT 界面仍在运行。请保存并关闭所有 AniBT 窗口，等待约 30 秒后重开。",
      );
  }
  const release = lock(lockFile);
  let close, app, server;
  try {
    app = makeApplication({ configFile, deps: { onIdle: () => close?.() } });
    server = http.createServer(app.handler);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (e) {
    release();
    throw e;
  }
  try {
    maybeAutomaticBackup(configFile);
  } catch {}
  const automaticBackupTimer = setInterval(() => {
    try {
      maybeAutomaticBackup(configFile);
    } catch {}
  }, 600000);
  automaticBackupTimer.unref();
  const port = server.address().port;
  atomicWrite(descriptor, { port, pid: process.pid, token: app.token });
  let closing = false;
  close = () => {
    if (closing) return;
    closing = true;
    clearInterval(automaticBackupTimer);
    server.close(() => {
      try {
        fs.unlinkSync(descriptor);
      } catch {}
      release();
      process.exit(0);
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  console.log("AniBT 图形界面已启动（仅本机可访问）。");
  if (open)
    openWindow(`http://127.0.0.1:${port}${windowPath}#token=${app.token}`);
  return server;
}
