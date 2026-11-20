import {
  episodeContext,
  showContext,
  deletionManifest,
  emptyAnimeFolders,
  digest,
} from "../episode-actions.js";
import {
  getReviewDraft,
  writeReviewDraft,
  clearReviewDraft,
  readDrafts,
} from "../review-drafts.js";
import { randomBytes } from "node:crypto";
import { validateReview } from "../reviews.js";
import { loadState, statePath } from "../runner.js";
import { buildProgress } from "../progress.js";
import { manualWorkReset } from "../forget-manual-work.js";
import {
  recheckDeletionWarnings,
  watchedOperations,
} from "../watched-operations.js";
import { localDownloader } from "../history-actions.js";
import { QbClient } from "../qb.js";
import { submitAgain, resetCompletion } from "../reprocessing.js";
import path from "node:path";
// Route boundary extracted without changing business decisions.
export function createProgressRoutes(ctx) {
  function readReset(key, items, config) {
    const file = statePath(config, ctx.configFile);
    const manual = ctx.readManual();
    const state = loadState(file, config, Object.values(manual));
    const tracking = ctx.readTracking();
    const drafts = readDrafts(ctx.configFile);
    const plan = manualWorkReset({
      key,
      items,
      config,
      state,
      manual,
      tracking,
      drafts,
    });
    const version = digest({
      key,
      records: plan.records,
      viewing: plan.viewing,
    });
    return { file, manual, state, tracking, drafts, plan, version };
  }
  return async function handle({ route, req, res, body, u }) {
    if (
      route === "POST /api/progress/manual/reset/preview" ||
      route === "POST /api/progress/manual/reset"
    ) {
      const key = body.key;
      if (
        typeof key !== "string" ||
        key.length > 500 ||
        !/^(bgm:\d{1,8}|title:.+)$/.test(key)
      )
        throw new Error("作品标识无效，请刷新进度。");
      const preview = route.endsWith("/preview");
      if (!preview && body.confirm !== true)
        throw new Error("请先核对作品并确认删除。");
      const items = await ctx.readFeed(false).catch(() => []);
      if (preview) {
        const { plan, version } = readReset(key, items, ctx.getConfig());
        ctx.json(res, 200, {
          title: plan.title,
          records: plan.records.length,
          version,
        });
        return;
      }
      const result = await ctx.localStateMutation(
        "reset-manual-work",
        async (config) => {
          const currentItems = await ctx.readFeed(false).catch(() => items);
          const reset = readReset(key, currentItems, config);
          if (body.version !== reset.version)
            throw Object.assign(
              new Error("作品记录或评价已变化，请重新预览后确认。"),
              { status: 409 },
            );
          const directory = path.join(path.dirname(ctx.configFile), "data");
          const completionFile = path.join(directory, "completions.json");
          const archiveFile = path.join(directory, "completion-history.json");
          const completion = ctx.readJsonFile(completionFile, {
            version: 1,
            tasks: {},
          });
          const archive = ctx.readJsonFile(archiveFile, []);
          if (
            completion?.version !== 1 ||
            !completion.tasks ||
            typeof completion.tasks !== "object" ||
            Array.isArray(completion.tasks) ||
            !Array.isArray(archive)
          )
            throw new Error("完成通知记录无法核对，请检查本机记录。");
          reset.plan.apply();
          const entries = [
            { file: reset.file, value: reset.state },
            { file: ctx.manualFile, value: reset.manual },
            { file: ctx.trackingFile, value: reset.tracking },
            {
              file: path.join(directory, "review-drafts.json"),
              value: reset.drafts,
            },
          ];
          const completed = Object.keys(completion.tasks).filter((hash) =>
            reset.plan.hashes.has(hash.toLowerCase()),
          );
          if (completed.length) {
            for (const hash of completed) delete completion.tasks[hash];
            entries.push({ file: completionFile, value: completion });
          }
          const nextArchive = archive.filter(
            (row) =>
              !reset.plan.hashes.has(String(row?.hash || "").toLowerCase()),
          );
          if (nextArchive.length !== archive.length)
            entries.push({ file: archiveFile, value: nextArchive });
          ctx.stateStore.commit(entries, { kind: "reset-manual-work" });
          return { ok: true, removed: reset.plan.records.length };
        },
      );
      ctx.json(res, 200, result);
      return;
    }
    if (route === "POST /api/progress/review/draft") {
      const tracking = ctx.readTracking(),
        key = body.key;
      if (
        typeof key !== "string" ||
        key.length > 500 ||
        !key.match(/^(bgm:\d{1,8}|title:.+)$/)
      )
        throw new Error("番剧信息无效。");
      const entryKey = ctx.trackedKey(tracking, key),
        entry = tracking[entryKey];
      if (!entry) throw new Error("观看记录不存在。");
      if (body.baseVersion !== digest(entry.personalReview || null))
        throw Object.assign(
          new Error("正式评价已变化，请重新打开并核对草稿。"),
          { status: 409 },
        );
      ctx.json(res, 200, writeReviewDraft(ctx.configFile, entryKey, body));
      return;
    }
    if (route === "POST /api/progress/rewatch") {
      ctx.requireRecovered();
      ctx.requireIdle();
      const tracking = ctx.readTracking();
      if (
        typeof body.key !== "string" ||
        !body.key.match(/^(bgm:\d{1,8}|title:.+)$/) ||
        body.key.length > 500
      )
        throw new Error("番剧信息无效。");
      const entryKey = ctx.trackedKey(tracking, body.key),
        entry = tracking[entryKey];
      if (
        body.confirm !== true ||
        !entry?.completedAt ||
        body.completedAt !== entry.completedAt ||
        body.reviewVersion !== digest(entry.personalReview || null)
      )
        throw new Error("观看记录或评价已变化，请重新预览重看。");
      const sessions = entry.watchSessions || [];
      if (sessions.length >= 100)
        throw new Error("观看经历已达 100 次，请先导出记录。");
      const draft = getReviewDraft(ctx.configFile, entryKey).draft,
        now = new Date().toISOString();
      sessions.push({
        id: randomBytes(8).toString("hex"),
        completedAt: entry.completedAt,
        startedAt: entry.rewatchStartedAt || "",
        ...(entry.personalReview
          ? { personalReview: entry.personalReview }
          : {}),
        ...(draft ? { draft } : {}),
      });
      entry.watchSessions = sessions;
      entry.rewatchStartedAt = now;
      entry.watched = 0;
      entry.episodeStates = {};
      entry.archived = false;
      delete entry.completedAt;
      delete entry.personalReview;
      tracking[body.key] = entry;
      if (entryKey !== body.key) delete tracking[entryKey];
      ctx.atomicWrite(ctx.trackingFile, tracking);
      clearReviewDraft(ctx.configFile, entryKey);
      ctx.json(res, 200, { ok: true, pastWatches: sessions.length });
      return;
    }
    if (
      route === "GET /api/progress/review" ||
      route === "POST /api/progress/review"
    ) {
      const key = req.method === "GET" ? u.searchParams.get("key") : body.key;
      if (
        typeof key !== "string" ||
        !key.match(/^(bgm:\d{1,8}|title:.+)$/) ||
        key.length > 500
      )
        throw new Error("番剧信息无效。");
      const tracking = ctx.readTracking(),
        entryKey = ctx.trackedKey(tracking, key),
        entry = tracking[entryKey];
      if (!entry) throw new Error("这部番的观看记录不存在，请刷新。");
      if (req.method === "GET") {
        ctx.json(res, 200, {
          key,
          title: entry.title,
          review: entry.personalReview || null,
          version: digest(entry.personalReview || null),
          sessions: entry.watchSessions || [],
          completedAt: entry.completedAt || "",
          ...getReviewDraft(ctx.configFile, entryKey),
        });
        return;
      }
      ctx.requireIdle();
      if (body.version !== digest(entry.personalReview || null))
        throw Object.assign(
          new Error("评价已在其他窗口修改，未覆盖；请保留本次内容后重新打开。"),
          { status: 409 },
        );
      const input = validateReview(body),
        now = new Date().toISOString();
      if (input.score === null && !input.text.trim() && !input.rewatch)
        delete entry.personalReview;
      else
        entry.personalReview = {
          ...input,
          createdAt: entry.personalReview?.createdAt || now,
          updatedAt: now,
        };
      ctx.atomicWrite(ctx.trackingFile, tracking);
      const existingDraft = getReviewDraft(ctx.configFile, entryKey);
      if (
        !existingDraft.draft ||
        body.draftVersion === existingDraft.draftVersion
      )
        clearReviewDraft(ctx.configFile, entryKey);
      ctx.json(res, 200, {
        key,
        title: entry.title,
        review: entry.personalReview || null,
        version: digest(entry.personalReview || null),
        sessions: entry.watchSessions || [],
        completedAt: entry.completedAt || "",
        ...getReviewDraft(ctx.configFile, entryKey),
      });
      return;
    }
    if (route === "POST /api/progress/show/restore") {
      ctx.requireRecovered();

      ctx.requireIdle();
      if (
        typeof body.key !== "string" ||
        !body.key.match(/^(bgm:\d{1,8}|title:.+)$/) ||
        body.key.length > 500
      )
        throw new Error("番剧信息无效。");
      const tracking = ctx.readTracking();
      const entryKey = ctx.trackedKey(tracking, body.key);
      if (!tracking[entryKey]?.completedAt)
        throw new Error("这部番不在我看过的列表中。");
      delete tracking[entryKey].completedAt;
      tracking[entryKey].archived = false;
      ctx.atomicWrite(ctx.trackingFile, tracking);
      ctx.json(res, 200, { ok: true });
      return;
    }
    if (route === "POST /api/progress/show/prepare") {
      ctx.requireRecovered();

      ctx.requireIdle();
      const c = ctx.getConfig(),
        state = loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        ),
        manual = ctx.readManual(),
        tracking = ctx.readTracking();
      let items = [];
      try {
        items = await ctx.readFeed(false);
      } catch {}
      const context = showContext({
          items,
          state,
          manual,
          config: c,
          key: body.key,
        }),
        show = buildProgress({
          items,
          state,
          manual,
          config: c,
          tracking,
        }).find((s) => s.key === body.key);
      if (!show) throw new Error("番剧记录已变化，请刷新进度。");
      const qb = ctx.deps.episodeQb || new QbClient(c);
      let targets, cleanupFolders;
      try {
        await (qb.connectForDownload ? qb.connectForDownload() : qb.login());
        targets = await deletionManifest(context, qb, c);
        cleanupFolders = await emptyAnimeFolders(show, targets, qb, c);
      } finally {
        await qb.logout();
      }
      const id = randomBytes(16).toString("hex"),
        plan = {
          id,
          key: show.key,
          end: Math.max(show.latest, context.latest),
          cleanupFolders,
          revision: ctx.revision(),
          tracking: digest(tracking),
          expires: Date.now() + 300000,
          targets: digest(targets),
        };
      ctx.showPlans.set(id, plan);
      for (const [key, p] of ctx.showPlans)
        if (p.expires < Date.now()) ctx.showPlans.delete(key);
      while (ctx.showPlans.size > 30)
        ctx.showPlans.delete(ctx.showPlans.keys().next().value);
      ctx.json(res, 200, {
        id,
        scope: "show",
        action: "watched",
        title: show.title,
        end: plan.end,
        cleanupFolders,
        targets,
        candidates: [],
        unknown: show.unknown,
        expires: plan.expires,
      });
      return;
    }
    if (route === "POST /api/progress/show/confirm") {
      ctx.requireRecovered();
      ctx.requireIdle();
      const plan = ctx.showPlans.get(body.id);
      if (body.confirm !== true || !plan || plan.expires < Date.now())
        throw new Error("请重新预览并二次确认全部看完的删除范围。");
      if (
        plan.revision !== ctx.revision() ||
        plan.tracking !== digest(ctx.readTracking())
      )
        throw new Error("设置或观看进度已变化，请重新预览。");
      ctx.showPlans.delete(plan.id);
      const result = await ctx.downloadMutation(
        "show-watched",
        async (qb, c) => {
          if (
            plan.revision !== ctx.revision() ||
            plan.tracking !== digest(ctx.readTracking())
          )
            throw new Error("设置或观看进度已变化，请重新预览。");
          const state = loadState(
              statePath(c, ctx.configFile),
              c,
              Object.values(ctx.readManual()),
            ),
            manual = ctx.readManual(),
            tracking = ctx.readTracking();
          let items = [];
          try {
            items = await ctx.readFeed(false);
          } catch {}
          const context = showContext({
              items,
              state,
              manual,
              config: c,
              key: plan.key,
            }),
            show = buildProgress({
              items,
              state,
              manual,
              config: c,
              tracking,
            }).find((s) => s.key === plan.key);
          if (!show || Math.max(show.latest, context.latest) !== plan.end)
            throw new Error("已知集数发生变化，请重新预览。");
          const targets = await deletionManifest(context, qb, c);
          if (digest(targets) !== plan.targets)
            throw new Error("任务或文件范围已变化，请重新预览。");
          const closedPlayers = await ctx.closeMpvForTargets(targets);
          if (
            closedPlayers &&
            digest(await deletionManifest(context, qb, c)) !== plan.targets
          )
            throw new Error("退出播放器后下载范围发生变化，请重新预览。");
          const priorKey = ctx.trackedKey(tracking, plan.key, c);
          return ctx.finishWatched(
            {
              scope: "show",
              key: plan.key,
              priorKey,
              title: show.title,
              bgmId: show.bgmId || "",
              end: plan.end,
              cleanupFolders: plan.cleanupFolders,
              watched: show.watched || 0,
              startEpisode: show.startEpisode || 1,
            },
            targets,
            qb,
            c,
            state,
            tracking,
            tracking[priorKey]?.showDeletion,
          );
        },
      );
      ctx.json(res, 200, result);
      return;
    }
    if (route === "POST /api/progress/episode/prepare") {
      ctx.requireRecovered();
      ctx.requireIdle();
      if (!["watched", "unwatched"].includes(body.action))
        throw new Error("请选择已看或未看。");
      const c = ctx.getConfig(),
        state = loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        ),
        manual = ctx.readManual(),
        tracking = ctx.readTracking();
      let items = [];
      try {
        items = await ctx.readFeed(false);
      } catch {}
      const context = episodeContext({
          items,
          state,
          manual,
          config: c,
          key: body.key,
          episode: body.episode,
        }),
        show = buildProgress({
          items,
          state,
          manual,
          config: c,
          tracking,
        }).find((s) => s.key === body.key);
      if (!show?.episodes.some((e) => e.number === body.episode))
        throw new Error("没有可核对的这一集，请刷新进度。");
      const options =
        body.action === "unwatched"
          ? context.candidates.filter((c) => !c.ambiguous)
          : context.candidates;
      const chosen = options.find((c) => c.hash === body.hash) || options[0];
      let targets = [],
        cleanupFolders = [];
      if (body.action === "unwatched" && !chosen)
        throw new Error("没有可提交的单集资源，请先到已有资源中查找版本。");
      if (body.action === "watched") {
        const qb = ctx.deps.episodeQb || new QbClient(c);
        try {
          await (qb.connectForDownload ? qb.connectForDownload() : qb.login());
          targets = await deletionManifest(context, qb, c);
          if (targets.length && body.episode === show.latest && show.bgmId) {
            const completed = await ctx
              .completedAnime(show.bgmId, show.title)
              .catch(() => null);
            if (completed?.episodes === body.episode)
              cleanupFolders = await emptyAnimeFolders(show, targets, qb, c);
          }
        } finally {
          await qb.logout();
        }
      }
      const id = randomBytes(16).toString("hex"),
        plan = {
          id,
          key: body.key,
          episode: body.episode,
          action: body.action,
          cleanupFolders,
          hash: chosen?.hash,
          revision: ctx.revision(),
          tracking: digest(tracking),
          expires: Date.now() + 300000,
          targets: digest(targets),
        };
      ctx.episodePlans.set(id, plan);
      for (const [k, v] of ctx.episodePlans)
        if (v.expires < Date.now()) ctx.episodePlans.delete(k);
      while (ctx.episodePlans.size > 30)
        ctx.episodePlans.delete(ctx.episodePlans.keys().next().value);
      ctx.json(res, 200, {
        id,
        title: show.title,
        episode: body.episode,
        action: body.action,
        selectedHash: chosen?.hash,
        cleanupFolders,
        candidates: options.map((c) => ({
          hash: c.hash,
          title: c.item.title,
          group: c.item.groupName,
          matched: c.matched,
          reason: c.reason,
        })),
        warning:
          body.action === "unwatched" && !chosen.matched ? chosen.reason : "",
        targets,
        expires: plan.expires,
      });
      return;
    }
    if (route === "POST /api/progress/episode/confirm") {
      ctx.requireRecovered();
      ctx.requireIdle();
      const plan = ctx.episodePlans.get(body.id);
      if (body.confirm !== true || !plan || plan.expires < Date.now())
        throw new Error("请重新预览并二次确认这一集的操作。");
      if (
        plan.revision !== ctx.revision() ||
        plan.tracking !== digest(ctx.readTracking())
      )
        throw new Error("设置或观看状态已变化，请重新预览确认。");
      ctx.episodePlans.delete(plan.id);
      const result = await ctx.downloadMutation(
        "episode-action",
        async (qb, c) => {
          if (
            plan.revision !== ctx.revision() ||
            plan.tracking !== digest(ctx.readTracking())
          )
            throw new Error("设置或观看状态已变化，请重新预览确认。");
          const state = loadState(
              statePath(c, ctx.configFile),
              c,
              Object.values(ctx.readManual()),
            ),
            manual = ctx.readManual(),
            tracking = ctx.readTracking();
          let items = [];
          try {
            items = await ctx.readFeed(false);
          } catch {}
          const context = episodeContext({
            items,
            state,
            manual,
            config: c,
            key: plan.key,
            episode: plan.episode,
          });
          const show = buildProgress({
            items,
            state,
            manual,
            config: c,
            tracking,
          }).find((s) => s.key === plan.key);
          if (!show) throw new Error("番剧状态已变化，请刷新。");
          const priorKey = ctx.trackedKey(tracking, plan.key, c);
          const entry = {
            ...tracking[priorKey],
            title: show.title,
            bgmId: show.bgmId || "",
            watched: show.watched || 0,
            startEpisode: show.startEpisode || 1,
            archived: !!show.archived,
            episodeStates: { ...show.episodeStates },
            deletedEpisodes: { ...show.deletedEpisodes },
          };
          let filesRemaining = 0,
            unknownFiles = 0,
            outcome;
          if (plan.action === "watched") {
            const targets = await deletionManifest(context, qb, c);
            if (digest(targets) !== plan.targets)
              throw new Error("qB 任务或文件列表已变化，请重新预览删除范围。");
            return ctx.finishWatched(
              {
                scope: "episode",
                key: plan.key,
                priorKey,
                title: show.title,
                bgmId: show.bgmId || "",
                episode: plan.episode,
                cleanupFolders: plan.cleanupFolders,
                watched: show.watched || 0,
                startEpisode: show.startEpisode || 1,
              },
              targets,
              qb,
              c,
              state,
              tracking,
              entry.deletedEpisodes[plan.episode],
            );
          } else {
            const chosen = context.candidates.find((x) => x.hash === plan.hash);
            if (!chosen || chosen.ambiguous)
              throw new Error("所选单集资源已变化或含多个集数，请重新选择。");
            if (!chosen.matched && body.acknowledgeRules !== true)
              throw new Error(
                "本次手动下载不符合自动规则，请核对字幕与规则后明确确认。",
              );
            outcome = await submitAgain(qb, chosen.item, {
              savePath: chosen.savePath,
              organizeByAnime: true,
              paused: false,
            });
            const now = new Date().toISOString(),
              old = Object.values(state.done).find(
                (x) => x.hash === chosen.hash,
              ),
              target = old || manual[chosen.hash] || {};
            Object.assign(target, {
              title: chosen.item.title,
              animeTitle: chosen.item.animeTitle,
              bgmId: chosen.item.bgmId,
              episode: String(plan.episode),
              version: chosen.item.version || "v1",
              hash: chosen.hash,
              at: now,
              status: "added",
              paused: false,
              savePath: outcome.savePath,
              reprocessedAt: now,
            });
            if (!old) {
              target.kind = "manual";
              manual[chosen.hash] = target;
            }
            if (chosen.item.episodeKey)
              state.episodes[chosen.item.episodeKey] =
                chosen.item.id || chosen.hash;
            resetCompletion(
              path.join(path.dirname(ctx.configFile), "data"),
              chosen.hash,
            );

            entry.episodeStates[plan.episode] = false;
            delete entry.deletedEpisodes[plan.episode];
          }
          tracking[plan.key] = entry;
          ctx.stateStore.commit(
            [
              { file: statePath(c, ctx.configFile), value: state },
              { file: ctx.manualFile, value: manual },
              { file: ctx.trackingFile, value: tracking },
            ],
            { kind: "episode-action" },
          );
          return { ok: true, action: plan.action, ...outcome };
        },
      );
      ctx.json(res, 200, result);
      return;
    }
    if (route === "POST /api/progress/recover") {
      if (body.confirm !== true)
        throw new Error("请确认核对并恢复本地记录；不会再次删除文件。");
      ctx.json(res, 200, await ctx.recoverWatched());
      return;
    }
    if (route === "GET /api/progress") {
      const c = ctx.getConfig(),
        state = loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        );
      let items = [],
        feedError = "";
      try {
        items = await ctx.readFeed(false);
      } catch (e) {
        feedError = e.message;
      }
      const tracking = ctx.readTracking();
      const hasDeletionWarning = (row) =>
        row?.filesRemaining || row?.unknownFiles || row?.folderErrors;
      const verifyFolders = Object.values(tracking).some(
        (entry) =>
          hasDeletionWarning(entry.showDeletion) ||
          Object.values(entry.deletedEpisodes || {}).some(hasDeletionWarning),
      );
      const {
          value: qb,
          taskHashes,
          taskFolders,
        } = await ctx.qbSnapshot(verifyFolders),
        completed = ctx.readJsonFile(
          path.join(path.dirname(ctx.configFile), "data/completions.json"),
          { tasks: {} },
        );
      if (qb.connected && localDownloader(c)) {
        try {
          recheckDeletionWarnings(
            tracking,
            watchedOperations(ctx.configFile).read,
            [...taskHashes],
            taskFolders,
          );
        } catch {
          // Preserve saved warnings if the evidence cannot be read.
        }
      }
      const manual = ctx.readManual();
      ctx.json(res, 200, {
        shows: buildProgress({
          items,
          state,
          manual,
          config: c,
          tracking,
          completed: completed.tasks,
          torrents: qb.torrents,
        }).map((show) => ({
          ...show,
          resources: show.resources.map(({ recordId, ...resource }) => ({
            ...resource,
            reDownloadKey:
              /^[a-f0-9]{40}$/.test(resource.hash) && manual[recordId]
                ? ctx.historyKey({ id: recordId, ...manual[recordId] })
                : "",
          })),
        })),
        feedError,
        qbConnected: qb.connected,
        historicalUnidentified: Object.values(state.done).filter(
          (j) =>
            ["added", "existing"].includes(j.status) &&
            !j.animeTitle &&
            !items.some((i) => i.infoHash === j.hash),
        ).length,
      });
      return;
    }
    if (route === "POST /api/progress") {
      ctx.requireRecovered();
      ctx.requireIdle();
      if (
        typeof body.key !== "string" ||
        body.key.length > 500 ||
        !body.key.match(/^(bgm:\d{1,8}|title:.+)$/) ||
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.length > 300
      )
        throw new Error("番剧信息无效。");
      for (const key of ["watched", "startEpisode"])
        if (
          !Number.isInteger(body[key]) ||
          body[key] < (key === "watched" ? 0 : 1) ||
          body[key] > 9999
        )
          throw new Error("集数需为有效整数。");
      if (typeof body.archived !== "boolean") throw new Error("归档状态无效。");
      const tracking = ctx.readTracking(),
        priorKey = ctx.trackedKey(tracking, body.key);
      tracking[body.key] = {
        ...tracking[priorKey],
        title: body.title,
        bgmId: body.key.startsWith("bgm:") ? body.key.slice(4) : "",
        watched: body.watched,
        startEpisode: body.startEpisode,
        archived: body.archived,
      };
      if (priorKey !== body.key) delete tracking[priorKey];
      ctx.atomicWrite(ctx.trackingFile, tracking);
      ctx.json(res, 200, { ok: true });
      return;
    }
    return false;
  };
}
