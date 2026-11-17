import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../src/state-store.js";
import { atomicWrite, clone, defaults } from "../src/config.js";
import { localSnapshots } from "../src/local-snapshots.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anibt-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config.json");
  const c = clone(defaults);
  c.rssUrl = "https://anibt.net/rss/subscriptions.xml?key=test";
  atomicWrite(config, c);
  return { root, config, c };
}
test("a partial multi-file commit blocks new writes and replays idempotently after restart", (t) => {
  const { root, config } = fixture(t);
  let count = 0;
  const store = createStateStore(config, {
    write: (file, value) => {
      if (++count === 2)
        throw Object.assign(Error("locked"), { code: "EPERM" });
      atomicWrite(file, value);
    },
  });
  const a = path.join(root, "data/tracking.json"),
    b = path.join(root, "data/manual-downloads.json");
  assert.throws(
    () =>
      store.commit([
        { file: a, value: { a: 1 } },
        { file: b, value: { b: 2 } },
      ]),
    { code: "STATE_RECOVERY_REQUIRED" },
  );
  assert.equal(store.summary().length, 1);
  assert.throws(() => store.write(config, {}), {
    code: "STATE_RECOVERY_REQUIRED",
  });
  const restarted = createStateStore(config);
  assert.equal(restarted.recover(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(a)), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(b)), { b: 2 });
  assert.equal(restarted.recover(), 0);
});
test("transaction targets and tampered journals are rejected before recovery writes", (t) => {
  const { root, config } = fixture(t),
    store = createStateStore(config);
  assert.throws(
    () =>
      store.commit([{ file: path.join(root, "../outside.json"), value: {} }]),
    /范围/,
  );
  let n = 0;
  const faulty = createStateStore(config, {
    write: () => {
      throw Error("fail");
    },
  });
  assert.throws(() => faulty.commit([{ file: config, value: {} }]));
  const journal = path.join(
    root,
    "data/transactions",
    fs.readdirSync(path.join(root, "data/transactions"))[0],
  );
  const value = JSON.parse(fs.readFileSync(journal));
  value.entries[0].value = { tampered: true };
  atomicWrite(journal, value);
  assert.throws(() => store.recover(), /无法核对/);
});
test("full local snapshots preserve pending and dedupe, pause restored queue and exclude browser profiles", (t) => {
  const { root, config, c } = fixture(t),
    store = createStateStore(config),
    snapshots = localSnapshots(config, {
      codec: (x, decrypt) =>
        decrypt
          ? Buffer.from(x, "base64").toString()
          : Buffer.from(x).toString("base64"),
    });
  atomicWrite(path.resolve(root, c.stateFile), {
    version: 1,
    sources: {},
    done: {},
    episodes: { "bgm:1:1:v1": "old" },
    pending: {
      a: { source: "x", item: { id: "a", title: "resource" }, paused: false },
    },
  });
  const created = snapshots.create(store);
  assert.equal(snapshots.list()[0].id, created.id);
  assert.equal(snapshots.preview(created.id).pending, 1);
  atomicWrite(path.resolve(root, c.stateFile), {
    version: 1,
    sources: {},
    done: {},
    episodes: {},
    pending: {},
  });
  snapshots.restore(created.id, store);
  const restored = JSON.parse(fs.readFileSync(path.resolve(root, c.stateFile)));
  assert.equal(restored.pending.a.paused, true);
  assert.equal(restored.episodes["bgm:1:1:v1"], "old");
  assert.throws(() => snapshots.preview("../escape"), /编号/);
  assert.equal(fs.existsSync(path.join(root, "data/account-browser")), false);
});
