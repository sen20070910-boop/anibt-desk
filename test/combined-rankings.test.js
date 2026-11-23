import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCombinedRanks,
  createCombinedRankings,
  COMBINED_SOURCES,
} from "../src/combined-rankings.js";
import { createAnimeRatings } from "../src/anime-ratings.js";

const key = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const game = (source, id, title, options = {}) => ({
  source,
  id,
  title,
  names: [title],
  year: "2020",
  format: "tv",
  score: source === "anilist" ? 90 : 9,
  scale: source === "anilist" ? 100 : 10,
  votes: 5000,
  cover: "",
  ...options,
});

function sample(source, candidates, complete = true) {
  return {
    rows: candidates.concat(
      Array.from({ length: 100 }, (_, index) =>
        game(source, String(index + 100), source + " reference " + index, {
          score: (4 + index / 20) * (source === "anilist" ? 10 : 1),
        }),
      ),
    ),
    candidateIds: candidates.map((row) => row.id),
    complete,
  };
}
const fixture = () =>
  new Map([
    [
      "bangumi",
      sample("bangumi", [
        game("bangumi", "1", "示例动画"),
        game("bangumi", "2", "只有两站"),
        game("bangumi", "3", "小样本", { score: 10, votes: 3 }),
        game("bangumi", "4", "同名重制", { year: "2024" }),
      ]),
    ],
    [
      "mal",
      sample("mal", [
        game("mal", "12", "An unrelated romanization", {
          score: 9.2,
          votes: null,
        }),
        game("mal", "14", "同名重制", { year: "2024" }),
      ]),
    ],
    [
      "anilist",
      sample("anilist", [
        game("anilist", "22", "Example Anime", {
          malId: "12",
          names: ["Example Anime", "示例动画"],
        }),
        game("anilist", "24", "同名重制", { year: "2020" }),
        game("anilist", "25", "小样本"),
      ]),
    ],
    [
      "douban",
      sample("douban", [
        game("douban", "32", "示例动画", { votes: null, score: 6.4 }),
        game("douban", "33", "只有两站"),
      ]),
    ],
  ]);

const nonOfficial = (ranked) =>
  [...ranked.ranked.filter((row) => row.supplemental), ...ranked.limited];

test("combines cross-linked IDs and exact aliases, withholding sparse and conflicting works", () => {
  const ranked = buildCombinedRanks(fixture(), key);
  assert.deepEqual(
    ranked.official.map((row) => row.title),
    ["示例动画"],
  );
  const [show] = ranked.official;
  assert.equal(show.coverage, 4);
  assert.equal(show.disagreement, true);
  assert.deepEqual(
    show.results.map((row) => row.rating.id),
    ["1", "12", "22", "32"],
  );
  assert.deepEqual(ranked.available, COMBINED_SOURCES);
  assert.deepEqual(
    nonOfficial(ranked)
      .filter((row) => row.title === "同名重制")
      .map((row) => row.coverage),
    [2, 1],
  );
  const douban = show.results[3].rating;
  assert.equal(douban.adjustedScore, douban.score);
  const lowVotes = nonOfficial(ranked).find((row) => row.title === "小样本")
    .results[0].rating;
  assert.ok(lowVotes.adjustedScore < 7 && lowVotes.percentile < 65);
  assert.equal(ranked.stability.checks.length, 4);
  assert.deepEqual(
    ranked.stability.checks.map((row) => row.topTenRetained),
    [1, 1, 1, 1],
  );
});

test("a shared ambiguous title without a year does not attach to either known edition", () => {
  const samples = fixture();
  const douban = samples.get("douban");
  douban.rows.push(game("douban", "34", "同名重制", { year: "" }));
  douban.candidateIds.push("34");
  const ranked = buildCombinedRanks(samples, key);
  assert.deepEqual(
    ranked.official.map((row) => row.title),
    ["示例动画"],
  );
  assert.deepEqual(
    nonOfficial(ranked)
      .filter((row) => row.title === "同名重制")
      .map((row) => row.coverage),
    [2, 1, 1],
  );
});

test("retains the full snapshot when a source drops, deduplicates pages and retries after cooldown", async () => {
  const samples = fixture();
  let now = 100_000,
    count = 0,
    outage = false;
  const ranking = createCombinedRankings(
    async (source) => {
      count++;
      if (outage && source === "anilist") throw Error("offline");
      return samples.get(source);
    },
    key,
    { now: () => now },
  );
  const [initial, sparse] = await Promise.all([
    ranking("tv", 1),
    ranking("tv", 1, false, true),
  ]);
  assert.equal(count, 4);
  assert.equal(initial.items[0].rank, 1);
  assert.equal(initial.metadata.stale, false);
  assert.ok(
    sparse.items.every((row) => row.rank === null && row.coverage <= 2),
  );
  outage = true;
  now += 61_000;
  const retained = await ranking("tv", 1, true);
  assert.equal(retained.metadata.stale, true);
  assert.equal(retained.metadata.updatedAt, initial.metadata.updatedAt);
  assert.deepEqual(retained.items, initial.items);
  outage = false;
  now += 61_000;
  const refreshed = await ranking("tv", 1, true);
  assert.equal(refreshed.metadata.stale, false);
  assert.equal(refreshed.metadata.updatedAt, now);
  assert.equal(count, 12);
});

test("combined ranking validates the requested chart before using the network", async () => {
  const network = {
    async read() {
      assert.fail("invalid input reached network");
    },
  };
  const api = createAnimeRatings(() => ({}), { network });
  await assert.rejects(api.ranking("combined", 1, false, "special"), /分类/);
  await assert.rejects(api.ranking("combined", 0, false, "tv"), /页码/);
});

test("the formal chart reaches rank 200 on page eight while still comparing the full eligible pool", async () => {
  const ranking = createCombinedRankings(
    async (source) =>
      sample(
        source,
        Array.from({ length: 250 }, (_, index) =>
          game(source, String(index + 1000), "作品 " + index),
        ),
      ),
    key,
  );
  const first = await ranking("tv", 1);
  const last = await ranking("tv", 8);
  assert.equal(first.metadata.eligible, 250);
  assert.equal(first.metadata.ranked, 200);
  assert.equal(last.totalPages, 8);
  assert.equal(last.items[0].rank, 176);
  assert.equal(last.items.at(-1).rank, 200);
  assert.equal(last.items.at(-1).topPercent, 100);
  assert.equal(last.hasNext, false);
  assert.equal((await ranking("tv", 9)).items.length, 0);
});

test("two-source matches fill the chart up to 200 without displacing stronger matches or ranking one-source titles", async () => {
  const ranking = createCombinedRankings(async (source) => {
    const candidates = ["bangumi", "douban"].includes(source)
      ? Array.from({ length: 225 }, (_, index) =>
          game(source, String(index + 1000), "双站动画 " + index))
      : [];
    return sample(source, [
      ...candidates,
      game(source, "998", "多站动画", { score: source === "anilist" ? 55 : 5.5 }),
      game(source, "999", "单站动画 " + source),
    ]);
  }, key);
  const first = await ranking("tv", 1);
  const last = await ranking("tv", 8);
  const limited = await ranking("tv", 1, false, true);
  assert.equal(first.items[0].title, "多站动画");
  assert.equal(first.items[0].coverage, 4);
  assert.ok(first.items[1].index > first.items[0].index);
  assert.equal(first.items[1].supplemental, true);
  assert.equal(last.items.at(-1).rank, 200);
  assert.deepEqual(last.items.at(-1).results.filter((row) => row.rating).map((row) => row.source), ["bangumi", "douban"]);
  assert.equal(last.metadata.supplemental, 199);
  assert.equal(last.metadata.eligible, 1);
  assert.equal(limited.metadata.limited, 30);
  assert.ok(limited.items.every((row) => row.rank === null));
  assert.ok(!first.items.some((row) => limited.items.some((other) => other.id === row.id)));
});
