import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { APP_VERSION, OFFICIAL_REPOSITORY } from "./release-info.js";

const statePath = (root) => path.join(root, "data/program-update.json");

export function portableUpdateState(root) {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), "utf8"));
  } catch {
    return {};
  }
}

function running(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function runHelper(root, args) {
  const helper = path.join(root, "scripts/app-update.ps1");
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  return spawn(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helper,
      "-InstallRoot",
      root,
      ...args,
    ],
    { cwd: root, windowsHide: true, detached: true, stdio: "ignore" },
  );
}

export async function guardPortableUpdate(root) {
  const current = portableUpdateState(root);
  if (!["waiting", "applying"].includes(current.phase)) return;
  if (running(current.pid))
    throw new Error("程序更新正在等待旧窗口关闭或正在安装，请稍候。");
  if (current.phase !== "applying") return;
  const child = runHelper(root, ["-Recover"]);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "上次更新中断，自动回退失败。请保留 data，使用便携包恢复程序文件。",
            ),
          ),
    );
  });
  throw new Error("上次更新中断，已恢复原版本。请重新打开 AniBT。");
}

export function createPortableUpdater({
  root,
  configFile,
  network,
  releaseChecker,
}) {
  const manifest = path.join(root, "release-manifest.json");
  let downloading = false,
    scheduled;
  function status() {
    const local = portableUpdateState(root);
    const supported =
      process.platform === "win32" &&
      process.arch === "x64" &&
      path.resolve(configFile) === path.join(root, "config.json") &&
      fs.existsSync(manifest) &&
      fs.existsSync(path.join(root, "scripts/app-update.ps1")) &&
      releaseChecker.settings().repository.toLowerCase() ===
        OFFICIAL_REPOSITORY;
    return {
      supported,
      phase: downloading ? "downloading" : local.phase || "",
      version: local.version || "",
      message: local.message || "",
      pending:
        scheduled?.exitCode === null ||
        (running(local.pid) && ["waiting", "applying"].includes(local.phase)),
    };
  }
  async function prepare(version) {
    const current = status();
    if (!current.supported)
      throw new Error("工具内安装适用于官方 Windows x64 便携版。");
    if (downloading || current.pending)
      throw new Error("已有程序更新正在处理。");
    if (
      typeof version !== "string" ||
      !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version)
    )
      throw new Error("请选择已检查到的新版。");
    downloading = true;
    let work;
    try {
      const latest = await releaseChecker.check({ force: true });
      if (
        !latest.newer ||
        latest.latestVersion !== version ||
        latest.url !==
          `https://github.com/${OFFICIAL_REPOSITORY}/releases/tag/v${version}`
      )
        throw new Error("线上版本已变化，请重新检查更新。");
      const asset = `AniBT-qB-v${version}-Windows-x64.zip`;
      const url = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/v${version}/${asset}`;
      const checksum = await network.read(url + ".sha256", {
        releaseAsset: true,
        maxBytes: 1024,
      });
      const fields = checksum.text.trim().split(/\s+/);
      if (
        fields.length !== 2 ||
        !/^[a-f0-9]{64}$/i.test(fields[0]) ||
        fields[1].replace(/^\*/, "") !== asset
      )
        throw new Error("发布校验文件格式有误，已停止安装。");
      const expected = fields[0].toLowerCase();
      const directory = path.join(root, "data/updates");
      fs.mkdirSync(directory, { recursive: true });
      work = fs.mkdtempSync(path.join(directory, "job-"));
      const zip = path.join(work, "update.zip");
      await network.read(url, {
        releaseAsset: true,
        destination: zip,
        maxBytes: 160 * 1024 * 1024,
        timeoutMs: 180000,
      });
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(zip)) hash.update(chunk);
      if (hash.digest("hex") !== expected)
        throw new Error("更新包 SHA-256 与发布记录不符，已停止安装。");
      const child = runHelper(root, [
        "-WorkDir",
        work,
        "-Version",
        version,
        "-PreviousVersion",
        APP_VERSION,
        "-ExpectedHash",
        expected,
        "-GuiPid",
        String(process.pid),
      ]);
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      scheduled = child;
      child.unref();
      return { queued: true, version };
    } catch (error) {
      if (work) fs.rmSync(work, { recursive: true, force: true });
      throw error;
    } finally {
      downloading = false;
    }
  }
  return { status, prepare };
}
