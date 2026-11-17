import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recheckDeletionWarnings } from '../src/watched-operations.js';

test('a copied deletion warning clears after the original file disappears, while unverifiable warnings remain', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibt-warning-'));
  const file = path.join(dir, '07.mkv');
  fs.writeFileSync(file, 'video');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  });
  const key = 'bgm:123', hash = 'a'.repeat(40);
  const target = { savePath: dir, hash, files: [{ name: '07.mkv' }] };
  const first = { id: 'first', key, scope: 'episode', episode: 7,
    status: 'committed', at: '2026-11-15T00:00:00Z', targets: [target] };
  const copied = { ...first, id: 'copied', at: '2026-11-16T00:00:00Z', targets: [] };
  const current = { operationId: 'copied', scope: 'episode', filesRemaining: 1 };
  const legacy = { scope: 'episode', filesRemaining: 1 };
  const tracking = { [key]: { deletedEpisodes: { 6: legacy, 7: current }, episodeStates: { 7: true } } };
  const read = () => [first, copied];
  recheckDeletionWarnings(tracking, read, []);
  assert.equal(current.filesRemaining, 1);
  fs.unlinkSync(file);
  recheckDeletionWarnings(tracking, read, [hash]);
  assert.equal(current.filesRemaining, 1);
  recheckDeletionWarnings(tracking, read, []);
  assert.equal(current.filesRemaining, 0);
  assert.equal(legacy.filesRemaining, 1);
  assert.equal(tracking[key].episodeStates[7], true);
});
