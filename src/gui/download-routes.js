import { loadState, statePath, lock } from "../runner.js";
import { readMaintenance, afterCleanup } from "../maintenance.js";
import path from "node:path";
import { inspectHistory, openHistoryFolder } from "../history-actions.js";
import { createSubtitleProbe } from "../media-subtitles.js";
import { QbClient } from "../qb.js";
import { submitAgain, resetCompletion } from "../reprocessing.js";
import { own } from "../dictionary.js";
import { defaults, clone } from "../config.js";
import { matches, matchingAnimeRule, norm } from "../feed.js";
import { randomBytes } from "node:crypto";
import { catchupRecommendations, resourceDownloadConfig } from "../catchup.js";
import { episodeRecorded } from "../episode-dedupe.js";
import {
  animeFolderName,
  animeDownloadPath,
  discoveryDownloadItem,
} from "../download-path.js";
import { applyAnimeBindings } from "../anime-bindings.js";
import { queueToken } from "../retries.js";
import {
  classifyDiscoveryFiles,
  selectDiscoveryFiles,
} from "../discovery-files.js";
// Route boundary extracted without changing business decisions.
export function createDownloadRoutes(ctx) {
  const filePreviews = new Map();
  const previewRequests = new Map();
  const probe =
    ctx.deps.subtitleProbe || createSubtitleProbe(ctx.root, ctx.configFile);
  return async function handle({ route, req, res, body, u }) {
    if (route === "POST /api/history/clear") {
      ctx.requireIdle();
      if (body.confirm !== true) throw new Error("请先确认清空处理历史。");
      const c = ctx.getConfig(),
        history = ctx
          .allHistory(
            loadState(
              statePath(c, ctx.configFile),
              c,
              Object.values(ctx.readManual()),
            ),
            ctx.readManual(),
          )
          .filter((row) =>
            afterCleanup(
              row,
              readMaintenance(path.join(path.dirname(ctx.configFile), "data")),
            ),
          );
      ctx.atomicWrite(ctx.historyDisplayFile, {
        hidden: history.map(ctx.historyKey),
      });
      ctx.record("处理历史已清空显示，下载任务和去重记录继续保留", "success");
      ctx.json(res, 200, { ok: true, hidden: history.length });
      return;
    }
    if (route === "POST /api/history/restore") {
      ctx.requireIdle();
      ctx.atomicWrite(ctx.historyDisplayFile, { hidden: [] });
      ctx.record("已恢复处理历史显示", "success");
      ctx.json(res, 200, { ok: true });
      return;
    }
    if (
      route === "GET /api/history/task" ||
      route === "POST /api/history/open-folder" ||
      route === "POST /api/history/subtitles"
    ) {
      const c = ctx.getConfig(),
        key = req.method === "GET" ? u.searchParams.get("key") : body.key,
        hash = req.method === "GET" ? u.searchParams.get("hash") : body.hash;
      const history = ctx.allHistory(
        loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        ),
        ctx.readManual(),
      );
      let row;
      if (hash !== undefined && hash !== null) {
        if (typeof hash !== "string" || !/^[a-f0-9]{40}$/i.test(hash))
          throw new Error("任务标识无效。");
        row = history.find((r) => r.hash?.toLowerCase() === hash.toLowerCase());
        if (!row) {
          const task = (await ctx.qbInfo(true)).torrents.find(
            (t) => t.hash?.toLowerCase() === hash.toLowerCase(),
          );
          if (task)
            row = {
              kind: "task",
              hash: task.hash,
              title: task.name,
              savePath: task.savePath,
            };
        }
      } else row = history.find((r) => ctx.historyKey(r) === key);
      if (!row) throw new Error("任务或记录已变化，请刷新下载状态。");
      const readSubtitles = route === "POST /api/history/subtitles";
      if (
        readSubtitles &&
        (!Number.isInteger(body.index) || body.index < 0 || body.index >= 2000)
      )
        throw new Error("请从当前任务中选择一个已下载的视频文件。");
      const info = await inspectHistory(
        row,
        c,
        ctx.deps.historyQb || new QbClient(c),
        readSubtitles ? { probe, subtitleIndex: body.index } : undefined,
      );
      if (readSubtitles) {
        if (!info.embeddedSubtitles)
          throw new Error(
            "这份视频尚未下载完成，或已无法在本机访问。请刷新任务详情。",
          );
        ctx.json(res, 200, info.embeddedSubtitles);
        return;
      }
      const completion = ctx.readJsonFile(
        path.join(path.dirname(ctx.configFile), "data/completions.json"),
        { tasks: {} },
      ).tasks?.[row.hash?.toLowerCase()];
      info.historicallyCompleted = !!(
        completion?.completed || completion?.completedAt
      );
      if (req.method === "POST") {
        if (body.native === true) {
          if (!info.canOpenFolder)
            throw new Error("没有可在本机打开的保存目录。");
          ctx.json(res, 200, { ok: true, folderPath: info.savePath });
        } else {
          await (ctx.deps.openHistoryFolder || openHistoryFolder)(info);
          ctx.json(res, 200, { ok: true });
        }
      } else ctx.json(res, 200, info);
      return;
    }
    if (route === "POST /api/history/reprocess") {
      if (body.confirm !== true || typeof body.key !== "string")
        throw new Error("请先确认重新处理的记录。");
      {
        const c = ctx.getConfig(),
          row = ctx
            .allHistory(
              loadState(
                statePath(c, ctx.configFile),
                c,
                Object.values(ctx.readManual()),
              ),
              ctx.readManual(),
            )
            .find((x) => ctx.historyKey(x) === body.key);
        if (!row || !/^[a-f0-9]{40}$/i.test(row.hash || ""))
          throw new Error("下载记录已变化或缺少种子标识，请刷新后重试。");
      }
      const result = await ctx.downloadMutation("reprocess", async (qb, c) => {
        const file = statePath(c, ctx.configFile),
          state = loadState(file),
          manual = ctx.readManual(),
          row = ctx
            .allHistory(state, manual)
            .find((x) => ctx.historyKey(x) === body.key);
        if (!row || !/^[a-f0-9]{40}$/i.test(row.hash || ""))
          throw new Error("下载记录已变化或缺少种子标识，请刷新后重试。");
        const hash = row.hash.toLowerCase(),
          paused = body.paused === undefined ? c.qb.paused : body.paused;
        if (typeof paused !== "boolean") throw new Error("暂停选项无效。");
        const outcome = await submitAgain(
          qb,
          {
            title: row.title,
            animeTitle: row.animeTitle,
            bgmId: row.bgmId,
            infoHash: hash,
            magnet: "magnet:?xt=urn:btih:" + hash,
          },
          {
            savePath: row.savePath,
            organizeByAnime: !!row.animeTitle,
            paused,
            requireExisting: row.selectiveDownload === true,
          },
        );
        const target =
          row.kind === "manual" ? manual[row.id] : own(state.done, row.id);
        Object.assign(target, {
          at: new Date().toISOString(),
          status: "added",
          paused,
          savePath: outcome.savePath,
          reprocessedAt: new Date().toISOString(),
        });
        resetCompletion(path.join(path.dirname(ctx.configFile), "data"), hash);
        ctx.stateStore.commit(
          [
            { file, value: state },
            { file: ctx.manualFile, value: manual },
          ],
          { kind: "manual-download" },
        );
        ctx.record("重新处理：" + row.title, "success");
        return { ok: true, ...outcome };
      });
      ctx.json(res, 200, result);
      return;
    }
    if (route === "GET /api/anime/resources") {
      const bgmId = u.searchParams.get("bgmId") || "",
        title = (u.searchParams.get("title") || "").slice(0, 300);
      let c;
      try {
        c = ctx.getConfig();
      } catch {
        c = clone(defaults);
      }
      const state = loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        ),
        manual = ctx.readManual();
      let list;
      if (bgmId)
        list = await ctx.animeResources.list({
          bgmId,
          groupSlug: u.searchParams.get("group") || "",
          episode: u.searchParams.get("episode") || "",
          refresh: u.searchParams.get("refresh") === "1",
        });
      else {
        if (!title) throw new Error("请指定番剧。");
        const items = (await ctx.readFeed(false))
          .filter((i) => norm(i.animeTitle) === norm(title))
          .slice(0, 100)
          .map((item) => {
            const resultId = randomBytes(16).toString("hex");
            ctx.fallbackResources.set(resultId, { item, at: Date.now() });
            return { ...item, resultId };
          });
        while (ctx.fallbackResources.size > 1000)
          ctx.fallbackResources.delete(
            ctx.fallbackResources.keys().next().value,
          );
        list = { items, limit: 100, localOnly: true };
      }
      const requested =
        u.searchParams.get("mode") ||
        (u.searchParams.get("catchup") === "1" ? "catchup" : "normal");
      if (!["normal", "auto", "catchup", "completed"].includes(requested))
        throw new Error("下载模式无效。");
      let mode = requested === "catchup" ? "catchup" : "normal",
        metadataUnavailable = false,
        animeMetadata = null;
      if (["auto", "catchup", "completed"].includes(requested) && bgmId) {
        try {
          animeMetadata = await ctx.lookupAnime(bgmId, title);
          if (animeMetadata?.status === "FINISHED") mode = "completed";
          else if (requested === "completed")
            throw new Error("尚未确认番剧完结，请改用普通资源下载。");
        } catch (error) {
          if (requested === "completed") throw error;
          metadataUnavailable = true;
        }
      }
      if (requested === "completed" && mode !== "completed")
        throw new Error("尚未确认番剧完结。");
      const resourceConfig = resourceDownloadConfig(c, mode);
      const rows = ctx
        .describeItems(list.items, resourceConfig, state, {})
        .map((row, i) => ({
          ...row,
          resultId: list.items[i].resultId,
          downloadable: /^[a-f0-9]{40}$/i.test(list.items[i].infoHash || ""),
          previouslyHandled:
            !!own(state.done, row.id) ||
            Object.values(state.done).some(
              (j) => j.hash === list.items[i].infoHash,
            ) ||
            !!manual[list.items[i].infoHash],
        }));
      const recommendedIds =
        mode !== "normal"
          ? catchupRecommendations(
              list.items,
              c,
              ctx.readTracking(),
              (item) =>
                !!episodeRecorded(state, item) ||
                rows.find((r) => r.resultId === item.resultId)
                  ?.previouslyHandled,
              mode,
            )
          : [];
      ctx.json(res, 200, {
        items: rows,
        recommendedIds,
        mode,
        metadataUnavailable,
        totalEpisodes: animeMetadata?.episodes ?? null,
        limit: list.limit,
        possiblyLimited: list.possiblyLimited,
        localOnly: !!list.localOnly,
      });
      return;
    }
    if (route === "POST /api/anime/resources/add") {
      if (
        body.confirm !== true ||
        !Array.isArray(body.selectedIds) ||
        !body.selectedIds.length ||
        body.selectedIds.length > 50 ||
        body.selectedIds.some((id) => typeof id !== "string")
      )
        throw new Error("请勾选 1–50 个资源并确认下载。");
      const selected = [...new Set(body.selectedIds)].map((id) => {
        const local = ctx.fallbackResources.get(id);
        if (local && Date.now() - local.at < 1800000) return local.item;
        return ctx.animeResources.resolve(id);
      });
      if (selected.some((i) => !/^[a-f0-9]{40}$/i.test(i.infoHash || "")))
        throw new Error("所选资源缺少种子标识，请刷新后重新选择。");
      const current = ctx.getConfig();
      if (
        selected.some(
          (i) =>
            current.filters.languages.includes("CHS") &&
            !i.languages.includes("CHS"),
        ) &&
        body.acknowledgeSubtitle !== true
      )
        throw new Error("所选资源有未标明简中的条目，请先核对并确认字幕。");
      const mode = body.mode || "normal";
      if (!["normal", "catchup", "completed"].includes(mode))
        throw new Error("下载模式无效。");
      if (mode === "completed") {
        const ids = new Set(selected.map((i) => String(i.bgmId || "")));
        if (
          ids.size !== 1 ||
          !(await ctx.completedAnime(
            selected[0].bgmId,
            body.title || selected[0].animeTitle,
          ))
        )
          throw new Error("无法确认这部番剧已完结，请刷新资源后再试。");
      }
      const downloadConfig = resourceDownloadConfig(current, mode);
      if (
        selected.some((i) => !matches(i, downloadConfig).ok) &&
        body.acknowledgeRules !== true
      )
        throw new Error(
          "所选资源有不符合自动偏好的条目，请先确认本次手动选择。",
        );
      const result = await ctx.downloadMutation(
        "resource-add",
        async (qb, c) => {
          const state = loadState(
              statePath(c, ctx.configFile),
              c,
              Object.values(ctx.readManual()),
            ),
            manual = ctx.readManual(),
            results = [];
          for (const item of selected) {
            try {
              const paused =
                body.paused === undefined ? c.qb.paused : body.paused;
              if (typeof paused !== "boolean")
                throw new Error("暂停选项无效。");
              const knownHash =
                Object.values(state.done).some(
                  (j) => j.hash === item.infoHash,
                ) || Object.hasOwn(manual, item.infoHash);
              if (
                c.dedupeEpisodes &&
                episodeRecorded(state, item) &&
                !knownHash &&
                body.allowAlternate !== true
              )
                throw new Error(
                  "这一集已有版本；如需收集多版本，请明确勾选允许同集多版本。",
                );
              const outcome = await submitAgain(qb, item, {
                organizeByAnime: true,
                paused,
              });
              const now = new Date().toISOString(),
                hash = item.infoHash;
              const previous = Object.values(state.done).find(
                (j) => j.hash === hash && j.status !== "episode-duplicate",
              );
              const target = previous || manual[hash] || {};
              Object.assign(target, {
                title: item.title,
                animeTitle: item.animeTitle,
                bgmId: item.bgmId,
                episode: item.episode,
                version: item.version,
                hash,
                sourceLinks: item.links || [],
                at: now,
                status: "added",
                paused,
                savePath: outcome.savePath,
                reprocessedAt: now,
              });
              if (!previous) {
                target.kind = "manual";
                manual[hash] = target;
              }
              if (item.episodeKey) state.episodes[item.episodeKey] = item.id;
              resetCompletion(
                path.join(path.dirname(ctx.configFile), "data"),
                hash,
              );
              ctx.stateStore.commit(
                [
                  { file: statePath(c, ctx.configFile), value: state },
                  { file: ctx.manualFile, value: manual },
                ],
                { kind: "resource-download" },
              );
              results.push({
                id: item.id,
                title: item.title,
                ok: true,
                ...outcome,
              });
            } catch (e) {
              results.push({
                id: item.id,
                title: item.title,
                ok: false,
                error: e.message,
              });
            }
          }
          ctx.record(
            "手动资源下载：成功 " +
              results.filter((r) => r.ok).length +
              " / " +
              results.length,
          );
          return { results };
        },
      );
      ctx.json(res, 200, result);
      return;
    }
    if (route === "GET /api/discover/search") {
      const sources = u.searchParams.get("sources");
      ctx.json(
        res,
        200,
        await ctx.discovery.search({
          query: u.searchParams.get("q") || "",
          ...(sources ? { sources: sources.split(",") } : {}),
          refresh: u.searchParams.get("refresh") === "1",
          fuzzy: u.searchParams.get("fuzzy") !== "0",
        }),
      );
      return;
    }
    if (route === "POST /api/discover/path") {
      const c = ctx.getConfig(),
        raw = ctx.discovery.peek
          ? ctx.discovery.peek(String(body.resultId || ""))
          : await ctx.discovery.resolve(String(body.resultId || "")),
        item = discoveryDownloadItem(
          raw,
          ctx.discoveryAssociation(body.association),
        );
      let savePath = "",
        waitingForQb = false;
      if (matchingAnimeRule(item, c)?.savePath?.trim() || c.qb.savePath?.trim())
        savePath = animeDownloadPath(item, c, "");
      else {
        const info = await ctx.qbInfo(false);
        if (info.connected && info.savePath)
          savePath = animeDownloadPath(item, c, info.savePath);
        else waitingForQb = true;
      }
      ctx.json(res, 200, {
        savePath,
        folderName: animeFolderName(item),
        animeTitle: item.animeTitle,
        waitingForQb,
      });
      return;
    }
    if (route === "POST /api/discover/tasks") {
      if (
        !Array.isArray(body.hashes) ||
        body.hashes.length > 240 ||
        body.hashes.some(
          (hash) => typeof hash !== "string" || !/^[a-f0-9]{40}$/i.test(hash),
        )
      )
        throw new Error("任务标识无效。");
      const hashes = [
        ...new Set(body.hashes.map((hash) => hash.toLowerCase())),
      ];
      ctx.json(
        res,
        200,
        await ctx.discoveryTaskPresence(hashes, body.refresh === true),
      );
      return;
    }
    if (route === "POST /api/discover/files") {
      const resultId = String(body.resultId || "");
      const now = Date.now();
      for (const [id, entry] of filePreviews) {
        if (now - entry.previewedAt > 600000) filePreviews.delete(id);
      }
      let pending = previewRequests.get(resultId);
      if (!pending) {
        if (previewRequests.size >= 3)
          throw new Error("正在读取其他资源的文件，请稍候再试。");
        pending = (async () => {
          let item = await ctx.discovery.resolve(resultId);
          const qb = ctx.deps.discoveryFileQb || new QbClient(ctx.getConfig());
          try {
            await (qb.connectForDownload
              ? qb.connectForDownload()
              : qb.login());
            const files = classifyDiscoveryFiles(
              await qb.discoveryFileManifest(item, {
                captureTorrent: (torrentData) => {
                  item = { ...item, torrentData };
                },
              }),
            );
            const previewId = randomBytes(16).toString("hex");
            while (filePreviews.size >= 4)
              filePreviews.delete(filePreviews.keys().next().value);
            filePreviews.set(previewId, {
              resultId,
              item,
              files,
              previewedAt: Date.now(),
            });
            return { previewId, files };
          } finally {
            await qb.logout();
          }
        })().finally(() => previewRequests.delete(resultId));
        previewRequests.set(resultId, pending);
      }
      ctx.json(res, 200, await pending);
      return;
    }
    if (route === "POST /api/discover/add") {
      let preview, fileSelection;
      if (body.fileSelection !== undefined) {
        preview = filePreviews.get(body.fileSelection?.previewId);
        if (
          !preview ||
          preview.resultId !== body.resultId ||
          Date.now() - preview.previewedAt > 600000
        ) {
          throw new Error("文件清单已过期，请重新读取并勾选。");
        }
        fileSelection = {
          files: preview.files,
          priorities: selectDiscoveryFiles(
            preview.files,
            body.fileSelection.indices,
          ),
        };
      }
      const result = await ctx.downloadMutation(
        "manual-add",
        async (qb, c) => {
          const association = ctx.discoveryAssociation(body.association),
            item = applyAnimeBindings(
              [
                discoveryDownloadItem(
                  preview?.item ||
                    (await ctx.discovery.resolve(String(body.resultId || ""))),
                  association,
                ),
              ],
              c,
            )[0];
          if (
            c.filters.languages.includes("CHS") &&
            !item.languages.includes("CHS") &&
            body.acknowledgeSubtitle !== true
          )
            throw new Error("这份资源未标明简中，请先核对并确认字幕需求。");
          let explicitPath = "";
          if (body.savePath !== undefined) {
            if (
              typeof body.savePath !== "string" ||
              body.savePath.length > 1000 ||
              /[\x00-\x1f]/.test(body.savePath)
            )
              throw new Error("下载目录无效。");
            explicitPath = body.savePath.trim();
            if (
              explicitPath &&
              !path.win32.isAbsolute(explicitPath) &&
              !path.posix.isAbsolute(explicitPath)
            )
              throw new Error("请输入完整的下载目录路径。");
          }
          if (body.paused !== undefined) {
            if (typeof body.paused !== "boolean")
              throw new Error("暂停选项无效。");
            c.qb.paused = body.paused;
          }
          const manual = ctx.readManual(),
            state = loadState(
              statePath(c, ctx.configFile),
              c,
              Object.values(manual),
            );
          await qb.ensureCategory();
          let existing = await qb.has(item.infoHash);
          const knownHash =
            Object.values(state.done).some((j) => j.hash === item.infoHash) ||
            Object.hasOwn(manual, item.infoHash);
          if (
            c.dedupeEpisodes &&
            episodeRecorded(state, item) &&
            !existing &&
            !knownHash &&
            body.allowAlternate !== true
          )
            throw Object.assign(
              new Error(
                "这一集已有版本；如需收集多版本，请明确勾选允许同集多版本。",
              ),
              { status: 409 },
            );
          let added,
            recovered = false;
          if (!existing) {
            try {
              added = await qb.add(item, {
                ...(explicitPath
                  ? { savePath: explicitPath, organizeByAnime: false }
                  : { organizeByAnime: true }),
                ...(fileSelection ? { fileSelection } : {}),
              });
            } catch (error) {
              if (fileSelection) throw error;
              if (await qb.has(item.infoHash)) {
                existing = true;
                recovered = true;
              } else throw error;
            }
          }
          const old = manual[item.infoHash];
          let originalPath = old?.savePath || "";
          if (existing && !originalPath)
            try {
              originalPath =
                (await qb.list()).find(
                  (t) => t.hash?.toLowerCase() === item.infoHash,
                )?.save_path || "";
            } catch {}
          const savePath =
            existing && !recovered
              ? originalPath
              : added?.savePath || explicitPath || originalPath;
          manual[item.infoHash] = {
            ...old,
            title: item.title,
            animeTitle: item.animeTitle,
            bgmId: item.bgmId || "",
            episode: String(item.episode || ""),
            version: item.version || "v1",
            sources: item.sources || [item.source],
            sourceLinks: item.links || [],
            releaseUrl: item.releaseUrl || "",
            at: old?.at || new Date().toISOString(),
            status:
              old?.status || (!existing || recovered ? "added" : "existing"),
            hash: item.infoHash,
            kind: "manual",
            paused: c.qb.paused || added?.startPending === true,
            ...(!existing && fileSelection
              ? { selectiveDownload: fileSelection.priorities.includes(0) }
              : {}),
            ...(recovered ? { confirmationRecovered: true } : {}),
            ...(savePath ? { savePath } : {}),
          };
          if (item.episodeKey)
            state.episodes[item.episodeKey] = item.id || item.infoHash;
          ctx.stateStore.commit(
            [
              { file: ctx.manualFile, value: manual },
              { file: statePath(c, ctx.configFile), value: state },
            ],
            { kind: "discovery-download" },
          );
          ctx.record("搜索资源已记入统一集数账本", "success");
          return {
            ok: true,
            existing,
            hash: item.infoHash,
            savePath,
            startPending: added?.startPending === true,
          };
        },
        ctx.deps.manualQb,
      );
      ctx.json(res, 200, result);
      return;
    }
    if (route === "POST /api/pending/action") {
      ctx.requireIdle();
      ctx.requireRecovered();
      if (
        !["pause", "retry"].includes(body.action) ||
        !Array.isArray(body.ids) ||
        !body.ids.length ||
        body.ids.length > 200 ||
        body.ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
      )
        throw new Error("请选择有效的待重试任务。");
      ctx.busy = "pending-update";
      const wasRunning = ctx.bg().running;
      let release;
      try {
        if (wasRunning) await ctx.script("stop");
        const c = ctx.getConfig();
        release = lock(statePath(c, ctx.configFile) + ".lock");
        const state = loadState(
            statePath(c, ctx.configFile),
            c,
            Object.values(ctx.readManual()),
          ),
          entries = new Map(
            Object.entries(state.pending).map(([id, row]) => [
              queueToken(id, row.source),
              row,
            ]),
          );
        if (body.ids.some((id) => !entries.has(id)))
          throw new Error("队列已变化，请刷新后重试。");
        for (const id of body.ids) {
          const row = entries.get(id);
          row.paused = body.action === "pause";
          if (body.action === "retry") {
            row.nextRetryAt = 0;
            delete row.waitUntil;
          }
        }
        ctx.atomicWrite(statePath(c, ctx.configFile), state);
        ctx.json(res, 200, { ok: true, changed: body.ids.length });
      } finally {
        release?.();
        ctx.busy = null;
        if (wasRunning) await ctx.script("start");
      }
      return;
    }
    return false;
  };
}
