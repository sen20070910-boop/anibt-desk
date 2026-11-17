import { catchupTiming } from "../catchup.js";
import {
  accountKeyHash,
  readAniBTControl,
  saveAniBTControl,
} from "../anibt-control.js";
import { loadState, statePath, lock } from "../runner.js";
import { randomBytes } from "node:crypto";
import { safeFetch } from "../feed.js";
import { mergeGroupOptions } from "../groups.js";
// Route boundary extracted without changing business decisions.
export function createSubscriptionRoutes(ctx) {
  return async function handle({ route, req, res, body, u }) {
    if (route === "GET /api/anibt/catalog") {
      ctx.json(
        res,
        200,
        await ctx.animeCatalog.search({
          query: u.searchParams.get("q") || "",
          cursor: u.searchParams.get("cursor") || "",
        }),
      );
      return;
    }
    if (route === "GET /api/anibt/catchup-check") {
      const title = (u.searchParams.get("title") || "").slice(0, 100),
        bgmId = u.searchParams.get("bgmId") || "";
      if (!/^\d{1,8}$/.test(bgmId) || !title)
        throw new Error("请指定番剧编号和番名。");
      const result = await ctx.animeCatalog.search({ query: title }),
        anime = result.items.find((i) => i.bgmId === bgmId);
      ctx.json(
        res,
        200,
        anime
          ? {
              ...catchupTiming(anime),
              title: anime.title,
              episodes: anime.episodes,
            }
          : { offer: false, unknown: true },
      );
      return;
    }
    if (route === "GET /api/anibt/season") {
      ctx.json(
        res,
        200,
        await ctx.animeCatalog.season({
          ...(u.searchParams.get("season")
            ? { season: u.searchParams.get("season") }
            : {}),
          refresh: u.searchParams.get("refresh") === "1",
        }),
      );
      return;
    }
    if (route === "GET /api/anibt/account") {
      const c = ctx.getConfig(),
        account = ctx.readAccount();
      ctx.json(res, 200, {
        linked: !!account && account.keyHash === accountKeyHash(c),
        user: account ? { id: account.id, name: account.name } : null,
      });
      return;
    }
    if (route === "POST /api/anibt/account") {
      ctx.requireIdle();
      const c = ctx.getConfig();
      if (
        !/^[a-zA-Z0-9_-]{1,128}$/.test(body.user?.id || "") ||
        !/^[a-f0-9]{64}$/.test(body.keyHash || "")
      )
        throw new Error("账号连接信息无效。");
      if (body.keyHash !== accountKeyHash(c)) {
        ctx.json(res, 200, {
          linked: false,
          error:
            "当前登录账号与私人 RSS 不一致。请在偏好设置换用该账号「我的订阅」里的完整私人 RSS，再连接。",
        });
        return;
      }
      const account = {
        id: body.user.id,
        name: String(body.user.name || "AniBT 用户").slice(0, 100),
        keyHash: body.keyHash,
        at: new Date().toISOString(),
      };
      ctx.atomicWrite(ctx.accountFile, account);
      ctx.json(res, 200, {
        linked: true,
        user: { id: account.id, name: account.name },
      });
      return;
    }
    if (route === "POST /api/anibt/begin") {
      ctx.requireIdle();
      const c = ctx.getConfig(),
        account = ctx.readAccount();
      if (
        !account ||
        account.id !== body.userId ||
        account.keyHash !== accountKeyHash(c)
      )
        throw new Error("请先连接与私人 RSS 一致的 AniBT 账号。");
      if (
        !["subscribe", "unsubscribe"].includes(body.action) ||
        !/^\d{1,8}$/.test(body.bgmId || "") ||
        Number(body.bgmId) < 1
      )
        throw new Error("番剧订阅操作无效。");
      ctx.busy = "website-subscription";
      const wasRunning = ctx.bg().running;
      let release;
      try {
        if (wasRunning) await ctx.script("stop");
        release = lock(statePath(c, ctx.configFile) + ".lock");
        const control = readAniBTControl(ctx.configFile, c),
          beforeBlocked = !!control.blocked[body.bgmId],
          id = randomBytes(16).toString("hex");
        if (body.action === "subscribe")
          control.baseline[body.bgmId] = {
            version: id,
            before: new Date().toISOString(),
          };
        else control.blocked[body.bgmId] = true;
        saveAniBTControl(ctx.configFile, control);
        ctx.websiteChange = {
          id,
          action: body.action,
          bgmId: body.bgmId,
          title:
            typeof body.title === "string"
              ? body.title.trim().slice(0, 300)
              : "",
          wasSubscribed: body.wasSubscribed === true,
          wasRunning,
          release,
          beforeBlocked,
        };
        ctx.websiteChange.timer = setTimeout(() => {
          ctx
            .finishWebsiteChange({ changeId: id, verified: false })
            .catch((e) => ctx.record(e.message, "error"));
        }, 90000);
        ctx.websiteChange.timer.unref?.();
        ctx.json(res, 200, { changeId: id });
        return;
      } catch (e) {
        release?.();
        ctx.busy = null;
        if (wasRunning) await ctx.script("start");
        throw e;
      }
    }
    if (route === "POST /api/anibt/finish") {
      ctx.json(res, 200, await ctx.finishWebsiteChange(body));
      return;
    }
    if (route === "POST /api/anibt/image") {
      ctx.json(res, 200, ctx.artwork.register(body.url));
      return;
    }
    if (route === "POST /api/anibt/covers") {
      ctx.json(
        res,
        200,
        await ctx.animeCatalog.covers({
          items: body.items,
          refresh: body.refresh === true,
        }),
      );
      return;
    }
    if (route === "GET /api/feed") {
      const c = ctx.getConfig(),
        items = await ctx.readFeed(u.searchParams.get("refresh") === "1");
      ctx.json(res, 200, {
        items: ctx.describeItems(
          items,
          c,
          loadState(
            statePath(c, ctx.configFile),
            c,
            Object.values(ctx.readManual()),
          ),
          readAniBTControl(ctx.configFile, c),
          ctx.readTracking(),
        ),
        fetchedAt: new Date(ctx.feedCache.at).toISOString(),
      });
      return;
    }
    if (route === "GET /api/groups") {
      const force = u.searchParams.get("refresh") === "1",
        bgmId = u.searchParams.get("bgmId") || "",
        title = (u.searchParams.get("title") || "").slice(0, 200),
        scoped = !!(bgmId || title);
      if (
        bgmId &&
        (!/^\d+$/.test(bgmId) || Number(bgmId) < 1 || Number(bgmId) > 10000000)
      )
        throw new Error("番剧编号无效。");
      let items = [],
        directory = [],
        published = [],
        warning = "",
        updatedAt = Date.now();
      const tasks = [
        ctx
          .readFeed(force)
          .then((result) => {
            items = result;
          })
          .catch(() => {
            warning = "订阅暂时无法刷新。";
          }),
      ];
      if (scoped && bgmId)
        tasks.push(
          (async () => {
            let cached = ctx.animeGroupCache.get(bgmId);
            try {
              if (force || !cached || Date.now() - cached.at > 60000) {
                const result = ctx.deps.animeGroups
                  ? await ctx.deps.animeGroups(bgmId)
                  : await (
                      await safeFetch(
                        "https://anibt.net/api/anime/groups?bgmId=" + bgmId,
                      )
                    ).json();
                if (!Array.isArray(result.data?.groups))
                  throw new Error("invalid groups");
                cached = { at: Date.now(), groups: result.data.groups };
                ctx.animeGroupCache.set(bgmId, cached);
              }
              published = cached.groups;
              updatedAt = cached.at;
            } catch {
              if (cached) published = cached.groups;
              warning +=
                (warning ? " " : "") +
                "本番发布组接口暂不可用，已保留订阅与缓存中的组。";
            }
          })(),
        );
      if (!scoped)
        tasks.push(
          (async () => {
            try {
              if (
                force ||
                !ctx.groupCache ||
                Date.now() - ctx.groupCache.at > 300000
              ) {
                const result = ctx.deps.groups
                  ? await ctx.deps.groups()
                  : await (
                      await safeFetch("https://anibt.net/api/subtitle-groups")
                    ).json();
                if (!Array.isArray(result.data))
                  throw new Error("invalid groups");
                ctx.groupCache = {
                  at: Date.now(),
                  groups: result.data.map(({ name, slug }) => ({
                    name,
                    slug,
                  })),
                };
              }
              directory = ctx.groupCache.groups;
              updatedAt = ctx.groupCache.at;
            } catch {
              if (ctx.groupCache) directory = ctx.groupCache.groups;
              warning +=
                (warning ? " " : "") +
                "全站目录暂不可用，已保留订阅与缓存中的组。";
            }
          })(),
        );
      await Promise.all(tasks);
      ctx.json(res, 200, {
        groups: mergeGroupOptions({
          items,
          directory,
          published,
          bgmId,
          title,
        }),
        scope: scoped ? "anime" : "all",
        updatedAt: new Date(updatedAt).toISOString(),
        warning,
      });
      return;
    }
    return false;
  };
}
