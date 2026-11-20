import { applyAnimeBindings } from "./anime-bindings.js";
import {
  animeIdentity,
  episodeIdentity,
  legacyEpisodeIdentity,
} from "./anime-identity.js";
import { isDirectDiscoveryRecord } from "./progress.js";
import { migrateEpisodeState } from "./episode-dedupe.js";

const submitted = (row) => ["added", "existing"].includes(row.status);
const references = (rows) =>
  new Set(
    rows.flatMap(({ id, row }) =>
      [id, row.id, row.hash, row.ledgerId].filter(Boolean),
    ),
  );

export function manualWorkReset({
  key,
  items,
  config,
  state,
  manual,
  tracking,
  drafts,
}) {
  const automatic = Object.entries(state.done).map(([id, row]) => ({
    id,
    row,
  }));
  const handAdded = Object.entries(manual).map(([id, row]) => ({ id, row }));
  const watching = Object.entries(tracking).map(([id, row]) => ({
    id,
    row: {
      animeTitle: row.title,
      bgmId: row.bgmId || (id.startsWith("bgm:") ? id.slice(4) : ""),
    },
  }));
  const knowledge = [
    ...items,
    ...automatic.map((x) => x.row),
    ...handAdded.map((x) => x.row),
    ...watching.map((x) => x.row),
  ];
  const resolve = (rows) => applyAnimeBindings(rows, config, knowledge);
  const matches = (row) => animeIdentity(row) === key;
  const selected = resolve(
    handAdded.map(({ id, row }) => ({ ...row, recordId: id })),
  ).filter(
    (row) => isDirectDiscoveryRecord(manual[row.recordId]) && matches(row),
  );
  const subscription = [
    ...items,
    ...automatic.filter((x) => submitted(x.row)).map((x) => x.row),
    ...handAdded
      .filter((x) => submitted(x.row) && !isDirectDiscoveryRecord(x.row))
      .map((x) => x.row),
    ...Object.values(state.pending).map((entry) => entry.item),
  ];
  if (resolve(subscription).some(matches))
    throw new Error("这部作品关联了 AniBT 追番记录，无法按独立手动下载清除。");
  if (!selected.some(submitted))
    throw new Error("未找到对应的手动下载作品，请刷新进度。");

  const workKeys = new Set([key]);
  const linked = resolve(watching.map((x) => x.row));
  watching.forEach(({ id }, index) => {
    if (matches(linked[index])) workKeys.add(id);
  });
  const recordIds = new Set(selected.map((row) => row.recordId));
  const removed = handAdded.filter(({ id }) => recordIds.has(id));
  const remaining = handAdded.filter(({ id }) => !recordIds.has(id));
  const removedRefs = references(removed);
  const keptRefs = references([...remaining, ...automatic]);
  const removedKeys = new Set(
    selected
      .flatMap((row) => [
        episodeIdentity(row),
        episodeIdentity({ ...row, bgmId: "" }),
        legacyEpisodeIdentity(row),
      ])
      .filter(Boolean),
  );
  const keptHashes = new Set(
    [...remaining, ...automatic].map(({ row }) => row.hash?.toLowerCase()),
  );
  const hashes = new Set(
    removed
      .map(({ id, row }) => String(row.hash || id).toLowerCase())
      .filter((hash) => /^[a-f0-9]{40}$/.test(hash) && !keptHashes.has(hash)),
  );

  return {
    title: tracking[key]?.title || selected[0].animeTitle || selected[0].title,
    records: removed,
    viewing: [...workKeys].map((id) => [
      id,
      tracking[id] || null,
      drafts[id] || null,
    ]),
    hashes,
    apply() {
      for (const { id } of removed) delete manual[id];
      for (const id of workKeys) {
        delete tracking[id];
        delete drafts[id];
      }
      for (const [episodeKey, ref] of Object.entries(state.episodes)) {
        if (
          !keptRefs.has(ref) &&
          (removedRefs.has(ref) || removedKeys.has(episodeKey))
        )
          delete state.episodes[episodeKey];
      }
      migrateEpisodeState(state, config, Object.values(manual));
    },
  };
}
