import path from "node:path";
import { spawn } from "node:child_process";
import { hasVideoExtension } from "./subtitle-language.js";

export async function closeMpvForTargets(installRoot, targets) {
  if (process.platform !== "win32" || !targets.length) return 0;
  const files = new Set();
  for (const target of targets) {
    if (!path.isAbsolute(target.savePath)) continue;
    for (const file of target.files) {
      if (!hasVideoExtension(file.name)) continue;
      const full = path.resolve(target.savePath, file.name);
      const relative = path.relative(target.savePath, full);
      if (
        relative &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
      )
        files.add(full);
    }
  }
  if (!files.size) return 0;
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          "无法确认正在占用视频的 mpv 已退出。请关闭播放窗口后重新确认删除。",
        ),
      );
    const shell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const child = spawn(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(installRoot, "scripts/close-playing-mpv.ps1"),
      ],
      { windowsHide: true, timeout: 20000, stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", fail);
    child.once("close", (code) => {
      const result = output.trim();
      if (code === 0 && /^\d+$/.test(result)) resolve(Number(result));
      else fail();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify([...files]));
  });
}
