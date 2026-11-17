import "../src/runtime-guard.js";
import { syncVersion } from "./sync-version.mjs";
syncVersion();
import { build } from "esbuild";
for (const [name, outfile] of [
  ["cli", "dist/anibt-qb.mjs"],
  ["gui", "dist/gui.mjs"],
  ["supervisor-cli", "dist/supervisor.mjs"],
])
  await build({
    entryPoints: [`src/${name}.js`],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "info",
  });
