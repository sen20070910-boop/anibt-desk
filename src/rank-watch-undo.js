import { createHash } from 'node:crypto';

function progress(entry) {
  const watched = Number.isInteger(entry?.watched) && entry.watched >= 0 && entry.watched <= 9999
    ? entry.watched : 0;
  const episodeStates = Object.fromEntries(Object.entries(entry?.episodeStates || {}).filter(
    ([episode, value]) => /^[1-9]\d{0,3}$/.test(episode) && typeof value === 'boolean',
  ));
  return { watched, archived: entry?.archived === true, episodeStates };
}

const fingerprint = entry => createHash('sha256').update(JSON.stringify(progress(entry))).digest('hex');

export function rankWatchUndo(before, after) {
  return { completedAt: after.completedAt, previous: progress(before), fingerprint: fingerprint(after) };
}

export function readRankWatchUndo(value, completedAt) {
  if (typeof completedAt !== 'string' || !completedAt || value?.completedAt !== completedAt ||
      typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      !value.previous || typeof value.previous !== 'object') return undefined;
  return { completedAt, previous: progress(value.previous), fingerprint: value.fingerprint };
}

export function clearWatchedMark(entry) {
  const undo = readRankWatchUndo(entry.rankWatchUndo, entry.completedAt);
  if (!undo) entry.archived = false;
  else if (undo.fingerprint === fingerprint(entry)) Object.assign(entry, undo.previous);
  delete entry.completedAt;
  delete entry.rankWatchUndo;
}
