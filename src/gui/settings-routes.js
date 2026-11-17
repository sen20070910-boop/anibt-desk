import { setMonthlyCleanup, cleanupHistory } from "../maintenance.js";
import path from "node:path";
import { validateProxy } from "../source-network.js";
import { loadState, statePath } from "../runner.js";
import { readAniBTControl } from "../anibt-control.js";
import { priorityWait } from "../priority.js";
import { sourceKey } from "../feed.js";
import fs from "node:fs";
import {
  defaults,
  clone,
  loadConfig,
  restoreDefaultPreferences,
} from "../config.js";
// Route boundary extracted without changing business decisions.
export function createSettingsRoutes(ctx) {
  return async function handle({ route, req, res, body, u }) {
    if (route === "GET /api/preferences") {
      ctx.json(res, 200, ctx.preferences());
      return;
    }
    if (route === "POST /api/maintenance/preferences") {
      ctx.requireIdle();
      ctx.json(
        res,
        200,
        setMonthlyCleanup(
          path.join(path.dirname(ctx.configFile), "data"),
          body.enabled,
        ),
      );
      return;
    }
    if (route === "POST /api/maintenance/clean") {
      ctx.requireIdle();
      if (body.confirm !== true) throw new Error("请确认清理历史并重新计数。");
      const result = cleanupHistory(
        path.join(path.dirname(ctx.configFile), "data"),
      );
      if (!result.ran) throw new Error("清理正在执行，请稍后重试。");
      ctx.events.length = 0;
      ctx.feedCache = null;
      ctx.qbCache = null;
      ctx.json(res, 200, result);
      return;
    }
    if (route === "POST /api/preferences") {
      const p = ctx.preferences();
      if (body.theme !== undefined) {
        if (!["system", "light", "dark"].includes(body.theme))
          throw new Error("请选择浅色、深色或跟随系统。");
        p.theme = body.theme;
      }
      if (body.design !== undefined) {
        if (
          !["classic", "morph", "apple"].includes(
            body.design,
          )
        )
          throw new Error("请选择有效的视觉风格。");
        p.design = body.design;
      }
      if (body.networkMode !== undefined) {
        if (!["auto", "direct", "custom"].includes(body.networkMode))
          throw new Error("请选择有效的联网方式。");
        p.networkMode = body.networkMode;
      }
      if (body.proxyUrl !== undefined)
        p.proxyUrl = validateProxy(
          body.proxyUrl || ctx.preferenceDefaults.proxyUrl,
        );
      ctx.atomicWrite(ctx.preferencesFile, p);
      ctx.json(res, 200, ctx.preferences());
      return;
    }
    if (route === "POST /api/rules/preview") {
      const c = ctx.getConfig();
      const patch = {
        filters: body.filters,
        rules: body.rules,
        startDate: body.startDate,
        startEpisode: body.startEpisode,
      };
      const draft = ctx.applyConfigPatch(c, patch),
        state = loadState(
          statePath(c, ctx.configFile),
          c,
          Object.values(ctx.readManual()),
        ),
        control = readAniBTControl(ctx.configFile, c);
      const items = await ctx.readFeed(false);
      const rows = ctx
        .describeItems(items, draft, state, control, ctx.readTracking())
        .map((row) => {
          const raw = items.find((i) => i.id === row.id),
            wait = priorityWait(raw, draft, state, sourceKey(c.rssUrl));
          let decision = !row.matched
            ? row.reason
            : row.status === "recorded"
              ? "已处理"
              : row.status === "duplicate"
                ? "同集版本已处理"
                : row.status === "baseline" ||
                    !state.sources[sourceKey(c.rssUrl)]
                  ? "已有资源 / 首次基线（需补下载）"
                  : wait
                    ? wait.reason
                    : "将作为下载候选，提交前再检查 qB 去重";
          return { ...row, decision };
        });
      ctx.json(res, 200, { rows });
      return;
    }
    if (route === "POST /api/config") {
      ctx.requireIdle();
      if (body.revision !== ctx.revision())
        throw Object.assign(
          new Error("配置已在其他位置更新，请刷新界面后重新保存。"),
          { status: 409 },
        );
      const current = fs.existsSync(ctx.configFile)
        ? loadConfig(ctx.configFile, { validate: false })
        : clone(defaults);
      const c = ctx.applyConfigPatch(current, body.config || {});
      ctx.atomicWrite(ctx.configFile, c);
      ctx.feedCache = null;
      ctx.qbCache = null;
      ctx.record("设置已保存，下次检查自动应用", "success");
      ctx.json(res, 200, {
        ok: true,
        config: ctx.publicConfig(c),
        revision: ctx.revision(),
      });
      return;
    }
    if (route === "POST /api/config/reset") {
      ctx.requireIdle();
      if (body.confirm !== true)
        throw new Error("请先确认恢复默认设置的范围。");
      if (
        typeof body.resetAnimeRules !== "boolean" ||
        typeof body.resetAppearanceNetwork !== "boolean"
      )
        throw new Error("请选择要恢复的设置范围。");
      if (body.revision !== ctx.revision())
        throw Object.assign(
          new Error("配置已在其他位置更新，请重新打开恢复默认设置窗口。"),
          { status: 409 },
        );
      const current = fs.existsSync(ctx.configFile)
          ? loadConfig(ctx.configFile, { validate: false })
          : clone(defaults),
        next = restoreDefaultPreferences(current, {
          resetAnimeRules: body.resetAnimeRules,
        });
      const oldPreferences =
        body.resetAppearanceNetwork && fs.existsSync(ctx.preferencesFile)
          ? fs.readFileSync(ctx.preferencesFile, "utf8")
          : null;
      let preferencesWritten = false;
      try {
        if (body.resetAppearanceNetwork) {
          ctx.atomicWrite(ctx.preferencesFile, ctx.preferenceDefaults);
          preferencesWritten = true;
        }
        ctx.atomicWrite(ctx.configFile, next);
      } catch (e) {
        if (preferencesWritten) {
          if (oldPreferences === null) {
            try {
              fs.unlinkSync(ctx.preferencesFile);
            } catch {}
          } else
            ctx.atomicWrite(ctx.preferencesFile, JSON.parse(oldPreferences));
        }
        throw e;
      }
      ctx.feedCache = null;
      ctx.qbCache = null;
      ctx.record(
        "已恢复全局默认偏好" +
          (body.resetAnimeRules ? "及单番规则" : "，单番规则保留") +
          (body.resetAppearanceNetwork ? "，主题和联网恢复默认" : ""),
        "success",
      );
      ctx.json(res, 200, {
        ok: true,
        config: ctx.publicConfig(next),
        revision: ctx.revision(),
        preferences: ctx.preferences(),
      });
      return;
    }
    return false;
  };
}
