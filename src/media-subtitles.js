import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  sidecarLanguage,
  subtitleLanguageCode,
  subtitleLanguageName,
} from "./subtitle-language.js";

const exec = promisify(execFile);

function findProbe(installRoot, configFile) {
  const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  let local = "";
  try {
    local = fs
      .readFileSync(
        path.join(path.dirname(configFile), "data/ffprobe-path.txt"),
        "utf8",
      )
      .trim();
  } catch {}
  return [
    local,
    path.join(installRoot, "tools", name),
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .filter(path.isAbsolute)
      .map((dir) => path.join(dir, name)),
  ].find((candidate) => {
    if (
      !path.isAbsolute(candidate) ||
      path.basename(candidate).toLowerCase() !== name
    )
      return false;
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function normalizeSubtitleTracks(payload) {
  if (!Array.isArray(payload.streams))
    throw new Error("视频字幕轨读取结果无效。");
  return payload.streams.slice(0, 128).map((track) => {
    const tags = Object.fromEntries(
      Object.entries(track.tags || {}).map(([key, value]) => [
        key.toLowerCase(),
        String(value).slice(0, 160),
      ]),
    );
    const title = tags.title || "";
    const tag = tags.language || "";
    const tagged = subtitleLanguageCode(tag);
    const named =
      subtitleLanguageCode(title) || sidecarLanguage(title + ".ass");
    const code =
      !tagged || (tagged === "ZH" && ["CHS", "CHT"].includes(named))
        ? named || tagged
        : tagged;
    return {
      language: subtitleLanguageName(
        code ||
          (/^[a-z]{2,3}$/i.test(tag) && tag.toLowerCase() !== "und" ? tag : ""),
      ),
      tag: tag === "und" ? "" : tag,
      title,
      codec: String(track.codec_name || "").slice(0, 48),
    };
  });
}

export function createSubtitleProbe(installRoot, configFile) {
  let scanning = false;
  return async (filename) => {
    if (scanning) throw new Error("正在读取另一份视频的字幕轨，请稍后再试。");
    const executable = findProbe(installRoot, configFile);
    if (!executable)
      throw new Error(
        "未找到 FFprobe。请安装 FFmpeg 并将其加入 PATH，或将 ffprobe.exe 放入工具目录下的 tools 文件夹。",
      );
    scanning = true;
    try {
      const { stdout } = await exec(
        executable,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,asf",
          "-probesize",
          "2000000",
          "-analyzeduration",
          "2000000",
          "-select_streams",
          "s",
          "-show_entries",
          "stream=codec_name:stream_tags=language,title",
          "-of",
          "json",
          "-i",
          filename,
        ],
        { windowsHide: true, timeout: 5000, maxBuffer: 256000 },
      );
      return normalizeSubtitleTracks(JSON.parse(stdout));
    } catch {
      throw new Error(
        "无法读取这份视频的字幕轨，请确认文件完整且容器格式受支持。",
      );
    } finally {
      scanning = false;
    }
  };
}
