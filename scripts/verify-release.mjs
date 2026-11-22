import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = JSON.parse(
  fs.readFileSync(path.join(root, "release/latest-build.json")),
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "anibt-release-"));
const extracted = path.join(temporary, "unpacked");
let child;
try {
  assert.equal(
    createHash("sha256").update(fs.readFileSync(build.zip)).digest("hex"),
    build.sha256,
  );
  const unpack = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/extract-release.ps1"),
      "-Archive",
      build.zip,
      "-Destination",
      extracted,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(unpack.status, 0, unpack.stderr);
  const product = path.join(extracted, "AniBT-qB"),
    manifest = JSON.parse(
      fs.readFileSync(path.join(product, "release-manifest.json")),
    );
  for (const row of manifest.files) {
    const file = path.resolve(product, row.path);
    assert.ok(file.startsWith(product + path.sep));
    assert.equal(
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      row.sha256,
      row.path,
    );
  }
  const executable = path.join(product, "runtime/node.exe");
  const help = spawnSync(
    executable,
    [path.join(product, "dist/anibt-qb.mjs"), "--help"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(build.version));
  const profile = path.join(temporary, "profile"),
    config = path.join(profile, "config.json");
  child = spawn(
    executable,
    [path.join(product, "dist/gui.mjs"), "--no-open", "--config", config],
    { stdio: "ignore", windowsHide: true },
  );
  let descriptor;
  for (let i = 0; i < 200; i++) {
    try {
      descriptor = JSON.parse(
        fs.readFileSync(path.join(profile, "data/gui.json")),
      );
      break;
    } catch {}
    if (child.exitCode !== null) throw Error("Extracted GUI exited early");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(descriptor, "GUI descriptor");
  const base = "http://127.0.0.1:" + descriptor.port,
    headers = { "x-app-token": descriptor.token };
  const json = async (route) => {
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  assert.equal((await json("/api/ping")).version, build.version);
  const status = await json("/api/status");
  assert.ok(status.configurationError);
  assert.equal(status.background.running, false);
  for (const asset of [
    "app.js",
    "settings.js",
    "status.js",
    "ratings.js",
    "library-tools.js",
    "motion.js",
    "motion.css",
    "overview-twilight.webp",
  ])
    assert.equal((await fetch(base + "/" + asset)).status, 200);
  const html = await (await fetch(base + "/")).text();
  assert.ok(!html.includes("__APP_VERSION__"));
  assert.ok(html.includes(build.version));
  assert.ok(html.includes('id="page-rankings"'));
  assert.ok(html.includes('id="ratings-search-form"'));
  assert.equal(
    fs.existsSync(config),
    false,
    "First run must not invent private configuration",
  );
  const proof = {
    version: build.version,
    sha256: build.sha256,
    at: new Date().toISOString(),
    files: manifest.files.length,
    archiveExtraction: true,
    cliHelp: true,
    unconfiguredGui: true,
    backgroundOff: true,
  };
  const registryFile = path.join(root, "release/verified-builds.json");
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryFile));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  registry[build.version] = proof;
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
