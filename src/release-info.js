import { APP_VERSION } from "./version.js";
export { APP_VERSION };

export const OFFICIAL_REPOSITORY = "sen20070910-boop/anibt-desk";
const day = 24 * 60 * 60 * 1000;

export function normalizeRepository(value) {
  if (
    typeof value !== "string" ||
    value.length > 180 ||
    (value &&
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(
        value,
      )) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error(
      "请填写 GitHub 仓库名称，如 owner/project；留空使用官方仓库。",
    );
  return value;
}

export function releaseInformation(payload, repository) {
  const tag = String(payload.tag_name || "");
  if (!/^v?\d+\.\d+\.\d+$/.test(tag) || payload.draft || payload.prerelease)
    throw new Error("发布版本资料无效。");
  const latestVersion = tag.replace(/^v/, "");
  const url = new URL(payload.html_url);
  const expected = "/" + repository + "/releases/tag/" + tag;
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.pathname.toLowerCase() !== expected.toLowerCase() ||
    url.search ||
    url.hash
  )
    throw new Error("发布页面地址不符。");
  const installed = APP_VERSION.split(".").map(Number);
  const parts = latestVersion.split(".").map(Number);
  const changed = parts.findIndex((part, index) => part !== installed[index]);
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    newer: changed >= 0 && parts[changed] > installed[changed],
    url: url.href,
    notes: String(payload.body || "").slice(0, 8000),
  };
}

export function createReleaseChecker({ read, write, network, now = Date.now }) {
  const pending = new Map();
  const settings = () => {
    const data = read() || {};
    let override = "";
    try {
      override = normalizeRepository(data.repository || "");
    } catch {}
    return {
      repository: override || OFFICIAL_REPOSITORY,
      override,
      last: data.last,
    };
  };
  const setRepository = (value) => {
    const repository = normalizeRepository(value);
    write({ repository });
    return settings();
  };
  async function check({ force = false } = {}) {
    const { repository, last } = settings();
    if (
      !force &&
      last?.repository === repository &&
      Number.isFinite(last.checkedAt) &&
      now() >= last.checkedAt &&
      now() - last.checkedAt < day
    ) {
      try {
        return {
          configured: true,
          ...releaseInformation(last.payload, repository),
        };
      } catch {}
    }
    if (!pending.has(repository)) {
      const work = (async () => {
        const response = await network.read(
          "https://api.github.com/repos/" + repository + "/releases/latest",
          {
            maxBytes: 512000,
            timeoutMs: 6000,
          },
        );
        const payload = JSON.parse(response.text);
        const info = releaseInformation(payload, repository);
        const current = settings();
        if (current.repository === repository) {
          try {
            write({
              repository: current.override,
              last: {
                repository,
                checkedAt: now(),
                payload: {
                  tag_name: payload.tag_name,
                  html_url: info.url,
                  body: info.notes,
                },
              },
            });
          } catch {} // The live result is still valid if the check timestamp cannot be saved.
        }
        return { configured: true, ...info };
      })().finally(() => pending.delete(repository));
      pending.set(repository, work);
    }
    return pending.get(repository);
  }
  return { settings, setRepository, check };
}
