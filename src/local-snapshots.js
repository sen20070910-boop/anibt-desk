import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { protectPassword, loadConfig, atomicWrite } from "./config.js";
import { exportBackup, validateBackup } from "./migration.js";
import { watchedOperations } from "./watched-operations.js";

const names = [
  "manual-downloads.json",
  "tracking.json",
  "review-drafts.json",
  "preferences.json",
  "anibt-control.json",
];
const read = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};
export function localSnapshots(configFile, { codec = protectPassword } = {}) {
  const root = path.dirname(path.resolve(configFile)),
    directory = path.join(root, "data/local-snapshots");
  const fileFor = (id) => {
    if (!/^\d{13}-[a-f0-9]{16}$/.test(id)) throw Error("快照编号无效。");
    return path.join(directory, id + ".dpapi");
  };
  function decode(id) {
    const file = fileFor(id);
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw Error("快照过大。");
    const value = JSON.parse(codec(fs.readFileSync(file, "utf8"), true));
    if (
      value.format !== "anibt-local-snapshot" ||
      value.version !== 1 ||
      value.root !== root
    )
      throw Error("这份快照不属于当前安装目录；请使用可迁移备份。");
    validate(value);
    return value;
  }
  function validate(value) {
    const { config, state, files } = value;
    if (
      !config ||
      !state ||
      !files ||
      !state.sources ||
      !state.done ||
      !state.episodes ||
      !state.pending ||
      state.version !== 1
    )
      throw Error("快照状态不完整。");
    validateBackup(
      {
        ...exportBackup(
          config,
          state,
          files["tracking.json"] || {},
          files["manual-downloads.json"] || {},
        ),
        reviewDrafts: files["review-drafts.json"] || {},
      },
      config,
    );
    if (
      Object.values(state.pending).some(
        (row) =>
          !row ||
          typeof row.source !== "string" ||
          !row.item ||
          typeof row.item.id !== "string" ||
          typeof row.item.title !== "string",
      )
    )
      throw Error("快照待处理队列无效。");
  }
  function list() {
    let items;
    try {
      items = fs.readdirSync(directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return items
      .filter((name) => /^\d{13}-[a-f0-9]{16}\.dpapi$/.test(name))
      .sort()
      .reverse()
      .map((name) => ({
        id: name.slice(0, -6),
        at: new Date(Number(name.slice(0, 13))).toISOString(),
        bytes: fs.statSync(path.join(directory, name)).size,
      }));
  }
  return {
    list,
    create(store) {
      store.assertClean();
      if (watchedOperations(configFile).pending().length)
        throw Error("请先恢复未完成的已看操作，再创建快照。");
      const config = loadConfig(configFile),
        state = read(path.resolve(root, config.stateFile), {
          version: 1,
          sources: {},
          done: {},
          episodes: {},
          pending: {},
        }),
        files = Object.fromEntries(
          names.map((name) => [name, read(path.join(root, "data", name), {})]),
        );
      const value = {
        format: "anibt-local-snapshot",
        version: 1,
        root,
        at: new Date().toISOString(),
        config,
        state,
        files,
      };
      validate(value);
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
        throw Error("状态超过本机快照的 16 MiB 限额，请先整理历史。");
      const id = Date.now() + "-" + randomBytes(8).toString("hex");
      fs.mkdirSync(directory, { recursive: true });
      const file = fileFor(id),
        temp = file + ".tmp";
      try {
        fs.writeFileSync(temp, codec(raw), { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, file);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
      return { id, at: value.at };
    },
    preview(id) {
      const value = decode(id);
      return {
        id,
        at: value.at,
        done: Object.keys(value.state.done).length,
        pending: Object.keys(value.state.pending).length,
        tracking: Object.keys(value.files["tracking.json"] || {}).length,
        requiresStoppedBackground: true,
      };
    },
    restore(id, store) {
      store.assertClean();
      if (watchedOperations(configFile).pending().length)
        throw Error("请先恢复未完成的已看操作。");
      const value = decode(id),
        current = loadConfig(configFile);
      value.config.stateFile = current.stateFile;
      for (const row of Object.values(value.state.pending)) {
        row.paused = true;
        row.nextRetryAt = null;
        row.lastError = "从本机快照恢复，请核对后手动重试";
      }
      store.commit(
        [
          { file: configFile, value: value.config },
          { file: path.resolve(root, current.stateFile), value: value.state },
          ...names.map((name) => ({
            file: path.join(root, "data", name),
            value: value.files[name] || {},
          })),
        ],
        { kind: "local-snapshot-restore" },
      );
      return { ok: true, pendingPaused: true, backgroundStopped: true };
    },
  };
}
