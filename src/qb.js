import { readLimited } from "./response-body.js";
import { safeFetch, matchingAnimeRule } from "./feed.js";
import { getPassword, validateDownloadPath } from "./config.js";
import { magnetHash, normalizeHash, torrentInfoHash } from "./torrent.js";
import { ensureQbRunning } from "./qb-launch.js";
import { animeDownloadPath } from "./download-path.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class QbClient {
  constructor(config) {
    this.config = config;
    this.base = config.qb.url.replace(/\/$/, "");
    this.cookie = "";
  }
  async connectForDownload() {
    await ensureQbRunning(this.config);
    return this.login();
  }
  async request(method, body, query = "") {
    const headers = {
      Referer: this.base + "/",
      Origin: new URL(this.base).origin,
    };
    if (this.cookie) headers.Cookie = this.cookie;
    return safeFetch(`${this.base}/api/v2/${method}${query}`, {
      headers,
      ...(body ? { method: "POST", body } : {}),
    });
  }
  async login() {
    const password = getPassword(this.config);
    const r = await this.request(
      "auth/login",
      new URLSearchParams({ username: this.config.qb.username, password }),
    );
    const responseText = (await r.text()).trim();
    if (responseText !== "Ok." && r.status !== 204)
      throw Object.assign(
        new Error("qBittorrent 登录失败，请检查用户名和密码。"),
        { code: "AUTH_FAILED" },
      );
    this.cookie = r.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    if (!this.cookie) throw new Error("qBittorrent 没有返回登录会话。");
    this.version = (await (await this.request("app/version")).text()).trim();
    return this.version;
  }
  async list() {
    return (await this.request("torrents/info")).json();
  }
  async has(hash) {
    return (
      await (
        await this.request(
          "torrents/info",
          null,
          "?hashes=" + encodeURIComponent(hash),
        )
      ).json()
    ).some((x) => x.hash.toLowerCase() === hash.toLowerCase());
  }
  async ensureCategory() {
    const name = this.config.qb.category;
    if (!name) return;
    const cats = await (await this.request("torrents/categories")).json();
    if (!Object.hasOwn(cats, name)) {
      const body = new URLSearchParams({ category: name });
      // A configured per-torrent save path is sent when adding, leaving category defaults intact.
      await this.request("torrents/createCategory", body);
    }
  }
  async discoveryFileManifest(item, { captureTorrent } = {}) {
    let data;
    try {
      if (item.torrentData) {
        if (torrentInfoHash(item.torrentData) !== item.infoHash)
          throw new Error("种子校验失败。");
        const form = new FormData();
        form.set(
          "torrents",
          new Blob([item.torrentData], { type: "application/x-bittorrent" }),
          "anibt.torrent",
        );
        const response = await this.request("torrents/parseMetadata", form);
        const parsed = JSON.parse(
          (
            await readLimited(response, {
              maxBytes: 4_000_000,
              label: "文件清单",
            })
          ).toString("utf8"),
        );
        // Initial Web API versions keyed the result by uploaded filename.
        data = Array.isArray(parsed) ? parsed[0] : parsed["anibt.torrent"];
      } else {
        const magnet = magnetForSelection(item);
        const deadline = Date.now() + 18000;
        do {
          const response = await this.request(
            "torrents/fetchMetadata",
            new URLSearchParams({ source: magnet }),
          );
          if (response.status !== 202) {
            data = JSON.parse(
              (
                await readLimited(response, {
                  maxBytes: 4_000_000,
                  label: "文件清单",
                })
              ).toString("utf8"),
            );
            break;
          }
          await response.body?.cancel();
          await sleep(1200);
        } while (Date.now() < deadline);
        if (!data)
          throw new Error(
            "磁力链接的文件清单还没有取到。请稍后重试，或换用有种子文件的版本。",
          );
      }
    } catch (error) {
      if ([404, 405].includes(error.httpStatus))
        throw new Error(
          "当前 qBittorrent 不支持添加前读取文件清单。请升级 qBittorrent，或在 qB 内手动添加并选文件。",
        );
      throw error;
    }
    const hash = normalizeHash(data?.infohash_v1 || data?.hash);
    const files = data?.info?.files || data?.files;
    if (
      hash !== item.infoHash ||
      !Array.isArray(files) ||
      !files.length ||
      files.length > 3000
    ) {
      throw new Error("无法核对这个种子的文件清单。");
    }
    const manifest = files.map((file) => {
      if (
        typeof file?.path !== "string" ||
        !file.path ||
        file.path.length > 1024 ||
        !Number.isSafeInteger(file.length) ||
        file.length < 0
      ) {
        throw new Error("文件清单存在无法识别的路径或大小。");
      }
      return { path: file.path.replaceAll("\\", "/"), size: file.length };
    });
    if (captureTorrent && !item.torrentData) {
      // qB's metadata cache belongs to this Web UI session. Keep verified
      // metadata for confirmation, so a second login won't need the peers again.
      const response = await this.request(
        "torrents/saveMetadata",
        new URLSearchParams({ source: magnetForSelection(item) }),
      );
      const torrentData = await readLimited(response, {
        maxBytes: 12_000_000,
        label: "种子",
      });
      if (torrentInfoHash(torrentData) !== item.infoHash) {
        throw new Error("磁力文件清单的种子校验失败，请重新读取。");
      }
      captureTorrent(torrentData);
    }
    return manifest;
  }

  async add(
    item,
    {
      stopped = this.config.qb.paused,
      savePath = this.config.qb.savePath,
      organizeByAnime = false,
      onSubmitting,
      fileSelection,
    } = {},
  ) {
    if (!item.infoHash)
      throw Object.assign(
        new Error("条目缺少 infohash，无法确认添加成功；已暂停此项。"),
        { code: "MISSING_HASH" },
      );
    if (organizeByAnime) {
      // Only query qB when a rule/root override cannot determine the path by itself.
      if (
        !matchingAnimeRule(item, this.config)?.savePath?.trim() &&
        !this.config.qb.savePath?.trim() &&
        !this.defaultSavePath
      ) {
        const prefs = await (await this.request("app/preferences")).json();
        this.defaultSavePath = validateDownloadPath(
          prefs.save_path,
          "qB 默认下载目录",
        );
      }
      savePath = animeDownloadPath(
        item,
        this.config,
        this.defaultSavePath || "",
      );
    }
    savePath = validateDownloadPath(savePath);
    const form = new FormData();
    // Hash-backed magnets allow qB to fetch metadata itself and keep RSS tokens out of qB.
    // Prefer .torrent uploads when available: works even when magnet metadata is unavailable.
    if (fileSelection) {
      const files = await this.discoveryFileManifest(item);
      if (
        files.length !== fileSelection.files.length ||
        files.some(
          (file, i) =>
            file.path !== fileSelection.files[i].path ||
            file.size !== fileSelection.files[i].size,
        )
      ) {
        throw new Error("文件清单已变化，请重新读取并勾选。");
      }
      form.set("urls", magnetForSelection(item));
      form.set("filePriorities", fileSelection.priorities.join(","));
    } else if (item.torrentUrl || item.torrentData) {
      const b =
        item.torrentData ||
        (await readLimited(await safeFetch(item.torrentUrl), {
          label: "种子",
        }));
      if (b.byteLength > 20_000_000 || new Uint8Array(b)[0] !== 100)
        throw Object.assign(new Error("下载到的文件不是有效种子。"), {
          code: "INVALID_TORRENT",
        });
      if (torrentInfoHash(b) !== item.infoHash)
        throw Object.assign(new Error("种子校验与预期不一致，已停止添加。"), {
          code: "HASH_MISMATCH",
        });
      form.set(
        "torrents",
        new Blob([b], { type: "application/x-bittorrent" }),
        "anibt.torrent",
      );
    } else {
      form.set("urls", item.magnet || `magnet:?xt=urn:btih:${item.infoHash}`);
    }
    const q = this.config.qb;
    if (savePath) {
      form.set("savepath", savePath);
      form.set("autoTMM", "false");
    }
    if (q.category) form.set("category", q.category);
    if (q.tags?.length) form.set("tags", q.tags.join(","));
    form.set("paused", String(stopped || !!fileSelection)); // qBittorrent 4.x
    form.set("stopped", String(stopped || !!fileSelection)); // qBittorrent 5.x
    await onSubmitting?.({ savePath });
    let r;
    try {
      r = await this.request("torrents/add", form);
    } catch (error) {
      error.submissionAttempted = true;
      throw error;
    }
    const responseText = (await r.text()).trim();
    // Newer qB 5.2 builds return a JSON result; older builds return Ok. or 204.
    // The hash lookup below is authoritative for every response format.
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {}
    if (
      responseText === "Fails." ||
      (result?.failure_count > 0 &&
        !result.success_count &&
        !result.pending_count)
    )
      throw Object.assign(
        new Error(
          "qBittorrent 明确拒绝添加；此项已暂停，请核对下载器和资源后重新排队。",
        ),
        { code: "ADD_REJECTED", submissionRejected: true },
      );
    for (let i = 0; i < 10; i++) {
      if (await this.has(item.infoHash)) {
        if (!fileSelection) return { savePath };
        await this.confirmFileSelection(
          item.infoHash,
          fileSelection.priorities,
        );
        if (!stopped) {
          try {
            await this.request(
              "torrents/start",
              new URLSearchParams({ hashes: item.infoHash }),
            );
          } catch {
            return { savePath, startPending: true };
          }
        }
        return { savePath };
      }
      await sleep(500);
    }
    throw Object.assign(
      new Error("尚未在 qBittorrent 中确认到任务；下一次会先查重再重试。"),
      { code: "CONFIRMATION_TIMEOUT", submissionAttempted: true },
    );
  }
  async confirmFileSelection(hash, priorities) {
    try {
      const r = await this.request(
        "torrents/files",
        null,
        "?hash=" + encodeURIComponent(hash),
      );
      const files = JSON.parse(
        (
          await readLimited(r, { maxBytes: 4_000_000, label: "文件清单" })
        ).toString("utf8"),
      );
      if (
        Array.isArray(files) &&
        files.length === priorities.length &&
        new Set(files.map((file) => file.index)).size === priorities.length &&
        files.every(
          (file) =>
            Number.isInteger(file.index) &&
            priorities[file.index] === file.priority,
        )
      )
        return;
    } catch {}
    throw new Error(
      "任务已添加为停止状态，但未能核对文件优先级。请在 qB 的「内容」页检查勾选，再手动开始下载。",
    );
  }
  async logout() {
    if (this.cookie) {
      try {
        await this.request("auth/logout", new URLSearchParams());
      } catch {}
      this.cookie = "";
    }
  }
}

function magnetForSelection(item) {
  return magnetHash(item.magnet) === item.infoHash
    ? item.magnet
    : "magnet:?xt=urn:btih:" + item.infoHash;
}
