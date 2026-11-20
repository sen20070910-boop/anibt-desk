import { syncVersion } from "./sync-version.mjs";
syncVersion({ check: true });
import "../src/runtime-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const nativeDirectory = process.argv
  .find((arg) => arg.startsWith("--native-dir="))
  ?.slice(13);
const toolchain = JSON.parse(
  fs.readFileSync(path.join(root, "toolchain.lock.json"), "utf8"),
);
if (process.platform !== toolchain.platform || process.arch !== toolchain.arch)
  throw Error("Portable release requires Windows x64.");
const runtimeRoot = path.join(
  root,
  ".tools/node",
  toolchain.node.version,
  "node-v" + toolchain.node.version + "-win-x64",
);
const runtime = path.join(runtimeRoot, "node.exe");
if (
  createHash("sha256").update(fs.readFileSync(runtime)).digest("hex") !==
  toolchain.node.executableSha256
)
  throw Error(
    "Pinned Node runtime checksum mismatch. Run bootstrap-toolchain.ps1.",
  );
const runtimeInfo = spawnSync(
  runtime,
  [
    "-p",
    "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})",
  ],
  { encoding: "utf8", windowsHide: true },
);
const runtimeMeta = JSON.parse(runtimeInfo.stdout);
if (
  runtimeMeta.version !== toolchain.node.version ||
  runtimeMeta.platform !== toolchain.platform ||
  runtimeMeta.arch !== toolchain.arch
)
  throw Error("Pinned runtime platform/version mismatch.");
const release = path.join(root, "release");
fs.mkdirSync(release, { recursive: true });
const staging = fs.mkdtempSync(path.join(release, `.stage-v${version}-`));
const target = path.join(staging, "AniBT-qB");
fs.mkdirSync(target, { recursive: true });
const copy = (relative, from = root) => {
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(from, relative), destination);
};
for (const file of [
  "打开图形界面.vbs",
  "创建桌面快捷方式.vbs",
  "anibt-qb.cmd",
  "开始使用.md",
  "使用说明.md",
  "发布说明.md",
  "README.md",
  "ENGINEERING.md",
  "config.example.json",
  "dist/anibt-qb.mjs",
  "dist/gui.mjs",
  "dist/supervisor.mjs",
  "scripts/background.ps1",
  "scripts/app-update.ps1",
  "scripts/close-playing-mpv.ps1",
  "scripts/install-gui-shortcut.ps1",
  "ui/index.html",
  "ui/performance.js",
  "ui/motion.js",
  "ui/motion.css",
  "ui/overview-twilight.webp",
  "ui/refined.css",
  "ui/morph.css",
  "ui/apple.css",
  "ui/apple.js",
  "ui/operation-recovery.js",
  "ui/queue.js",
  "ui/morph.js",
  "ui/app.js",
  "ui/settings.js",
  "ui/status.js",
  "ui/covers.js",
  "ui/backfill.js",
  "ui/history.js",
  "ui/discover.js",
  "ui/anibt.js",
  "ui/anibt-site-bridge.js",
  "ui/help.js",
  "ui/workbench.js",
  "ui/reviews.js",
  "ui/library-tools.js",
  "ui/episode-actions.js",
  "ui/resources.js",
  "ui/overview.js",
  "ui/maintenance.js",
  "ui/improvements.js",
  "ui/session.js",
  "ui/history-actions.js",
  "ui/settings-defaults.js",
  "ui/theme.js",
  "ui/style.css",
  "ui/icon.svg",
  "ui/anibt.ico",
  "native/AniBT.exe",
  "native/Microsoft.Web.WebView2.Core.dll",
  "native/Microsoft.Web.WebView2.Wpf.dll",
  "native/WebView2Loader.dll",
  "toolchain.lock.json",
  "licenses/Microsoft-WebView2-LICENSE.txt",
]) {
  if (nativeDirectory && file.startsWith("native/")) {
    fs.mkdirSync(path.join(target, "native"), { recursive: true });
    fs.copyFileSync(
      path.resolve(root, nativeDirectory, path.basename(file)),
      path.join(target, file),
    );
  } else copy(file);
}
fs.mkdirSync(path.join(target, "runtime"));
fs.copyFileSync(runtime, path.join(target, "runtime/node.exe"));
fs.copyFileSync(
  path.join(runtimeRoot, "LICENSE"),
  path.join(target, "licenses/node-LICENSE.txt"),
);
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let inCode = false,
  guide = "",
  contents = [],
  section = 0;
for (const rawLine of fs
  .readFileSync(path.join(root, "使用说明.md"), "utf8")
  .split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  if (line.startsWith("```")) {
    guide += inCode ? "</code></pre>" : "<pre><code>";
    inCode = !inCode;
    continue;
  }
  if (inCode) {
    guide += escape(line) + "\n";
    continue;
  }
  const heading = line.match(/^(#{1,3}) (.*)$/);
  if (heading) {
    const id = "section-" + section++;
    guide += `<h${heading[1].length} id="${id}">${escape(heading[2])}</h${heading[1].length}>`;
    if (heading[1].length === 2)
      contents.push(`<a href="#${id}">${escape(heading[2])}</a>`);
  } else if (line.trim())
    guide += `<p${line.startsWith("- ") ? ' class="item"' : ""}>${line.startsWith("- ") ? "• " : ""}${escape(line.replace(/^- /, "")).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`;
}
fs.writeFileSync(
  path.join(target, "使用说明.html"),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AniBT 完整使用说明</title><style>:root{color-scheme:light dark;--bg:#f7f7fa;--paper:#fff;--ink:#302a3c;--muted:#71677c;--line:#e6dfed}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.9 "Microsoft YaHei",system-ui,sans-serif}main{max-width:1160px;margin:40px auto;display:grid;grid-template-columns:230px 1fr;gap:30px;padding:0 22px}nav{position:sticky;top:25px;align-self:start}nav strong{font-size:20px;display:block;margin-bottom:15px}nav a{display:block;color:var(--muted);text-decoration:none;padding:6px 0;font-size:12px}article{padding:30px 40px;background:var(--paper);border:1px solid var(--line);border-radius:22px}h1{font-size:26px;line-height:1.5}h2{font-size:21px;margin-top:38px;scroll-margin-top:24px}p{color:var(--muted);overflow-wrap:anywhere}.item{padding-left:15px;text-indent:-12px;margin:10px 0}pre{padding:18px;background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:auto;line-height:1.8}code{font:13px/1.8 Consolas,monospace;color:var(--ink)}@media(prefers-color-scheme:dark){:root{--bg:#17131f;--paper:#25202e;--ink:#e7d9f0;--muted:#bdacc9;--line:#4b375b}}@media(max-width:800px){main{display:block;margin:20px auto}nav{position:static;margin-bottom:22px}article{padding:20px}h1{font-size:23px}}@media print{nav{display:none}main{display:block;margin:0}article{border:0;padding:0}body{font-size:11pt}}</style><main><nav><strong>AniBT 使用说明</strong>${contents.join("")}</nav><article>${guide}</article></main></html>`,
);

const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const notices = [
  "# Third-party notices",
  "",
  `Application version: ${version}`,
  `Bundled runtime: Node.js v${toolchain.node.version} (${toolchain.arch})`,
  "",
  "Node.js and its bundled dependencies: licenses/node-LICENSE.txt",
  "Microsoft WebView2 SDK: licenses/Microsoft-WebView2-LICENSE.txt",
  "Microsoft WebView2 Runtime is installed separately and is not bundled here.",
  "",
  "Bundled JavaScript dependencies:",
  "",
];
for (const [relative, meta] of Object.entries(lock.packages || {})) {
  if (!relative || meta.dev) continue;
  const folder = path.join(root, relative),
    pkg = JSON.parse(
      fs.readFileSync(path.join(folder, "package.json"), "utf8"),
    );
  const licenses = fs
    .readdirSync(folder)
    .filter(
      (name) =>
        /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(name) &&
        fs.statSync(path.join(folder, name)).isFile(),
    );
  if (pkg.name === "opencc-js")
    licenses.push("LICENSES/Apache-2.0.txt", "THIRD_PARTY_LICENSES.md");
  if (!licenses.length) {
    const fallback = {
      "@nodable/entities": "nodable-entities",
      boolbase: "boolbase",
    }[pkg.name];
    if (!fallback)
      throw new Error(`Missing dependency license file: ${pkg.name}`);
    for (const suffix of ["LICENSE.txt", "SOURCE.txt"])
      copy(`licenses/${fallback}-${suffix}`);
    notices.push(
      `- ${pkg.name} ${pkg.version}: ${pkg.license}; licenses/${fallback}-LICENSE.txt (upstream source in SOURCE.txt)`,
    );
    continue;
  }
  const label = pkg.name.replace(/[^a-z0-9_.-]/gi, "_") + "-" + pkg.version;
  for (const name of licenses) {
    const relativeLicense = `licenses/npm/${label}/${name}`;
    fs.mkdirSync(path.dirname(path.join(target, relativeLicense)), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(folder, name),
      path.join(target, relativeLicense),
    );
  }
  notices.push(
    `- ${pkg.name} ${pkg.version}: ${pkg.license || "see license file"}; licenses/npm/${label}/`,
  );
}
fs.writeFileSync(
  path.join(target, "THIRD_PARTY_NOTICES.md"),
  notices.join("\n") + "\n",
);
const files = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) walk(absolute);
    else files.push(absolute);
  }
}
walk(target);
if (
  files.some(
    (f) =>
      ["config.json", "gui.json", "state.json", "background.json"].includes(
        path.basename(f),
      ) || path.relative(target, f).split(path.sep).includes("data"),
  )
)
  throw new Error("Private files found in release.");
const secrets = [];
try {
  const c = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  const u = new URL(c.rssUrl);
  for (const key of ["key", "token"])
    if (u.searchParams.get(key)) secrets.push(u.searchParams.get(key));
  for (const p of [c.qb?.password, c.qb?.passwordEncrypted])
    if (p) secrets.push(p);
} catch (e) {
  if (e.code !== "ENOENT")
    throw new Error("Cannot complete the private-data check.");
}
for (const file of files) {
  const bytes = fs.readFileSync(file);
  if (secrets.some((s) => bytes.includes(Buffer.from(s))))
    throw new Error("Private credential detected in release.");
}
const manifest = files.map((file) => ({
  path: path.relative(target, file).replaceAll("\\", "/"),
  sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
}));
fs.writeFileSync(
  path.join(target, "release-manifest.json"),
  JSON.stringify(
    {
      version,
      platform: runtimeMeta.platform + "-" + runtimeMeta.arch,
      runtime: runtimeMeta,
      toolchain,
      files: manifest,
    },
    null,
    2,
  ) + "\n",
);
const zip = path.join(release, `AniBT-qB-v${version}-Windows-x64.zip`);
const packed = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts/pack-release.ps1"),
    "-Source",
    target,
    "-Destination",
    zip,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (packed.status !== 0)
  throw new Error(packed.stderr || "Archive creation failed.");
const sha = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
fs.writeFileSync(zip + ".sha256", `${sha}  ${path.basename(zip)}\n`);
fs.writeFileSync(
  path.join(release, "latest-build.json"),
  JSON.stringify(
    {
      version,
      zip,
      staging: target,
      sha256: sha,
      files: manifest.length,
      privateDataCheck: "passed",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    zip,
    sizeMB: (fs.statSync(zip).size / 1048576).toFixed(1),
    files: manifest.length,
    privateDataCheck: "passed",
  }),
);
