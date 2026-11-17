import {
  exportBackup,
  validateBackup,
  verifyBackupPaths,
} from "../migration.js";
import { loadState, statePath, lock } from "../runner.js";
import { readDrafts } from "../review-drafts.js";
import fs from "node:fs";
import { defaults, clone, loadConfig } from "../config.js";
import { randomBytes } from "node:crypto";
import { digest } from "../episode-actions.js";
import { maybeAutomaticBackup } from "../continuity.js";
import { sourceKey } from "../feed.js";
import path from "node:path";
// Route boundary extracted without changing business decisions.
export function createBackupRoutes(ctx) {
  return async function handle({ route, req, res, body, u }) {
    if (route === "GET /api/backup/export") {
      const c = ctx.getConfig();
      ctx.json(res, 200, {
        ...exportBackup(
          c,
          loadState(
            statePath(c, ctx.configFile),
            c,
            Object.values(ctx.readManual()),
          ),
          ctx.readTracking(),
          ctx.readManual(),
        ),
        reviewDrafts: readDrafts(ctx.configFile),
      });
      return;
    }
    if (route === "POST /api/backup/preview") {
      ctx.requireIdle();
      const current = fs.existsSync(ctx.configFile)
        ? loadConfig(ctx.configFile, { validate: false })
        : clone(defaults);
      const validated = validateBackup(body, current);
      const id = randomBytes(16).toString("hex");
      ctx.migrationPlan = {
        ...validated,
        ...(body._restoreViewing === true
          ? {
              next: clone(current),
              restoreViewing: true,
              viewingDigest: digest(ctx.readTracking()),
              draftDigest: digest(readDrafts(ctx.configFile)),
            }
          : {}),
        id,
        revision: ctx.revision(),
        expires: Date.now() + 300000,
      };
      ctx.json(res, 200, {
        id,
        ...validated.summary,
        restoreViewing: body._restoreViewing === true,
      });
      return;
    }
    if (route === "POST /api/backup/restore") {
      ctx.requireRecovered();
      ctx.requireIdle();
      if (
        body.confirm !== true ||
        !ctx.migrationPlan ||
        body.id !== ctx.migrationPlan.id ||
        Date.now() > ctx.migrationPlan.expires
      )
        throw new Error("请重新预览并确认导入。");
      if (ctx.migrationPlan.revision !== ctx.revision())
        throw new Error("本机配置已变化，请重新预览导入。");
      const plan = ctx.migrationPlan;
      verifyBackupPaths(plan, body);
      if (
        plan.restoreViewing &&
        (plan.viewingDigest !== digest(ctx.readTracking()) ||
          plan.draftDigest !== digest(readDrafts(ctx.configFile)))
      )
        throw new Error("观看记录或草稿已变化，请重新预览恢复。");
      const wasRunning = ctx.bg().running;
      let release, result;
      ctx.busy = "restore";
      const entries = [];
      const write = (file, value) => entries.push({ file, value });
      try {
        if (wasRunning) await ctx.script("stop");
        if (plan.restoreViewing) {
          if (
            plan.viewingDigest !== digest(ctx.readTracking()) ||
            plan.draftDigest !== digest(readDrafts(ctx.configFile))
          )
            throw new Error("观看记录或草稿已变化，请重新预览。");
          const protection = maybeAutomaticBackup(ctx.configFile, {
            force: true,
          });
          if (!protection.ran)
            throw new Error("恢复前的保护备份未完成，请稍后重试。");
        }
        const c = fs.existsSync(ctx.configFile)
            ? loadConfig(ctx.configFile, { validate: false })
            : clone(defaults),
          file = statePath(c, ctx.configFile);
        release = lock(file + ".lock");
        const state = loadState(file),
          backup = plan.backup;
        if (!plan.restoreViewing) {
          state.done = { ...backup.state.done, ...state.done };
          state.episodes = { ...backup.state.episodes, ...state.episodes };
          if (c.rssUrl) {
            const key = sourceKey(c.rssUrl),
              old = state.sources[key];
            state.sources[key] = {
              ...(old || { initializedAt: new Date().toISOString() }),
              baselineIds: [
                ...new Set([
                  ...(old?.baselineIds || []),
                  ...backup.state.baselineIds,
                ]),
              ],
            };
          }
          write(file, state);
          write(ctx.manualFile, { ...backup.manual, ...ctx.readManual() });
          write(ctx.configFile, plan.next);
        }
        write(
          ctx.trackingFile,
          plan.restoreViewing
            ? { ...ctx.readTracking(), ...backup.tracking }
            : { ...backup.tracking, ...ctx.readTracking() },
        );
        const drafts = readDrafts(ctx.configFile);
        if (plan.restoreViewing)
          for (const key of Object.keys(backup.tracking)) delete drafts[key];
        write(
          path.join(path.dirname(ctx.configFile), "data/review-drafts.json"),
          plan.restoreViewing
            ? { ...drafts, ...(backup.reviewDrafts || {}) }
            : { ...(backup.reviewDrafts || {}), ...drafts },
        );
        ctx.stateStore.commit(entries, { kind: "backup-restore" });
        ctx.migrationPlan = null;
        ctx.feedCache = null;
        ctx.qbCache = null;
        result = { ok: true, requiresConnection: !c.rssUrl };
      } finally {
        release?.();
        ctx.busy = null;
        if (wasRunning && !ctx.stateStore.pending().length)
          try {
            await ctx.script("start");
          } catch (e) {
            if (!result) throw e;
            result.warning = "备份已导入，但后台恢复失败：" + e.message;
            ctx.record(result.warning, "error");
          }
      }
      ctx.json(res, 200, result);
      return;
    }
    return false;
  };
}
