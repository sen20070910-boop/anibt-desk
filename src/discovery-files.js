const videos = /\.(?:mkv|mp4|m4v|avi|webm|mov|wmv|ts|m2ts)$/i;
const subtitles = /\.(?:ass|ssa|srt|vtt|sup|sub|idx)$/i;
const audio =
  /\.(?:mka|flac|aac|ac3|eac3|dts|dtshd|truehd|opus|wav|mp3|ogg|m4a)$/i;
const extraFolders =
  /^(?:sps?|specials?|extras?|bonus|cds?|ost|scans?|menus?|ncop|nced|bdmv|certificates?|特典|映像特典|扫图|掃圖)$/i;
const extraVideo =
  /(?:^|[\s._[(])(?:ncop|nced|tv\s?cm|sp|pv|trailer)(?:\d{0,3})(?=$|[\s._\])])/i;
const simplified =
  /(?:^|[\s._[(\]-])(?:sc|chs|gb(?:2312)?|zh[-_]?(?:hans|cn))(?=$|[\s._[\])\-])|简(?:体|中|日|繁)|簡(?:體|中|日|繁)/i;
const traditional =
  /(?:^|[\s._[(\]-])(?:tc|cht|big5|zh[-_]?(?:hant|tw))(?=$|[\s._[\])\-])|繁(?:体|體|中|日)/i;

function fileStem(path) {
  return path.slice(0, path.lastIndexOf(".")).normalize("NFKC").toLowerCase();
}

export function classifyDiscoveryFiles(files) {
  const rows = files.map(({ path, size }, index) => {
    const parts = path.split("/");
    const name = parts.at(-1);
    const stem = fileStem(path);
    const extra =
      parts.slice(0, -1).some((part) => extraFolders.test(part)) ||
      (videos.test(name) && extraVideo.test(fileStem(name)));
    const font =
      /\.(?:ttf|otf|ttc|otc)$/i.test(name) ||
      (/\.(?:zip|7z|rar)$/i.test(name) &&
        /(?:^|[\s._[(])fonts?(?=$|[\s._\])])/i.test(fileStem(name)));
    const kind = extra
      ? "extra"
      : videos.test(name)
        ? "video"
        : subtitles.test(name)
          ? "subtitle"
          : audio.test(name)
            ? "audio"
            : font
              ? "font"
              : "other";
    const nameMatches = simplified.test(fileStem(name));
    const language =
      kind === "subtitle"
        ? nameMatches
          ? "简中"
          : traditional.test(fileStem(name))
            ? "繁中"
            : "语言未标注"
        : "";
    return { index, path, size, kind, language, stem };
  });
  const videoStems = new Set(
    rows.filter((row) => row.kind === "video").map((row) => row.stem),
  );
  const basenameCounts = new Map();
  for (const stem of videoStems) {
    const basename = stem.split("/").at(-1);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }
  const uniqueNames = new Set(
    [...basenameCounts]
      .filter(([, count]) => count === 1)
      .map(([name]) => name),
  );
  const selectedSubtitle = (row) =>
    row.kind === "subtitle" &&
    row.language === "简中" &&
    (hasCompanion(row.stem, videoStems) ||
      hasCompanion(row.stem.split("/").at(-1), uniqueNames));
  const hasAss = rows.some(
    (row) => selectedSubtitle(row) && /\.(?:ass|ssa)$/i.test(row.path),
  );
  return rows.map((row) => ({
    index: row.index,
    path: row.path,
    size: row.size,
    kind: row.kind,
    language: row.language,
    recommended:
      row.kind === "video" ||
      selectedSubtitle(row) ||
      (row.kind === "font" && hasAss),
  }));
}

function hasCompanion(stem, videoStems) {
  // Sidecars typically append a language code to the video's exact name.
  if (videoStems.has(stem)) return true;
  for (const match of stem.matchAll(/[.\s_[(-]/g)) {
    if (videoStems.has(stem.slice(0, match.index))) return true;
  }
  return false;
}

export function selectDiscoveryFiles(files, indices) {
  if (
    !Array.isArray(indices) ||
    !indices.length ||
    indices.length > files.length ||
    indices.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= files.length,
    )
  ) {
    throw new Error("请从当前文件列表中至少勾选一个文件。");
  }
  const chosen = new Set(indices);
  return files.map((_, index) => (chosen.has(index) ? 1 : 0));
}
