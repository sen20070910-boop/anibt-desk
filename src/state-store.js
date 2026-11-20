import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { atomicWrite } from "./config.js";

const domainFiles = [
  "manual-downloads.json",
  "tracking.json",
  "review-drafts.json",
  "completions.json",
  "completion-history.json",
  "anibt-control.json",
  "preferences.json",
];
const checksum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createStateStore(configFile, { write = atomicWrite } = {}) {
  const root = path.dirname(path.resolve(configFile)),
    directory = path.join(root, "data/transactions");
  function allowed() {
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configFile));
    } catch {}
    return new Set([
      path.resolve(configFile),
      path.resolve(root, config.stateFile || "data/state.json"),
      ...domainFiles.map((name) => path.join(root, "data", name)),
    ]);
  }
  function pending() {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return names
      .filter((n) => /^[a-f0-9]{32}\.json$/.test(n))
      .map((name) => {
        const record = JSON.parse(
          fs.readFileSync(path.join(directory, name), "utf8"),
        );
        if (
          record.version !== 1 ||
          record.id + ".json" !== name ||
          record.sha256 !== checksum(record.entries) ||
          !Array.isArray(record.entries) ||
          !record.entries.length ||
          record.entries.some((row) => !allowed().has(path.resolve(row.file)))
        )
          throw Error("本地事务日志无法核对，已停止写入。");
        return record;
      });
  }
  function assertClean() {
    if (pending().length)
      throw Object.assign(
        Error("本地多文件更新尚未完成，请核对并恢复记录；不要重复提交下载。"),
        { code: "STATE_RECOVERY_REQUIRED" },
      );
  }
  function durable(file, value) {
    atomicWrite(file, value);
    const fd = fs.openSync(file, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function apply(record) {
    for (const row of record.entries) {
      write(row.file, row.value);
      const fd = fs.openSync(row.file, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.unlinkSync(path.join(directory, record.id + ".json"));
  }
  return {
    pending,
    assertClean,
    write(file, value) {
      if (allowed().has(path.resolve(file))) assertClean();
      return write(file, value);
    },
    commit(entries, { kind = "domain-update" } = {}) {
      assertClean();
      const targets = allowed(),
        normalized = entries.map((row) => ({
          file: path.resolve(row.file),
          value: row.value,
        }));
      if (
        !normalized.length ||
        normalized.some((row) => !targets.has(row.file)) ||
        new Set(normalized.map((row) => row.file)).size !== normalized.length
      )
        throw Error("事务写入范围无效。");
      const record = {
        version: 1,
        id: randomBytes(16).toString("hex"),
        kind,
        at: new Date().toISOString(),
        entries: normalized,
        sha256: checksum(normalized),
      };
      durable(path.join(directory, record.id + ".json"), record);
      try {
        apply(record);
      } catch (error) {
        throw Object.assign(
          Error("本地多文件更新部分完成，操作日志已保存，等待恢复。"),
          { code: "STATE_RECOVERY_REQUIRED", cause: error },
        );
      }
      return { ok: true, id: record.id };
    },
    recover() {
      let recovered = 0;
      for (const record of pending()) {
        apply(record);
        recovered++;
      }
      return recovered;
    },
    summary: () =>
      pending().map((row) => ({
        id: row.id,
        kind: row.kind,
        at: row.at,
        files: row.entries.length,
        message: "本地多文件更新部分完成，待恢复",
      })),
  };
}
