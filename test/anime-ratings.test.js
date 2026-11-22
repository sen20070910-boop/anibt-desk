import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnimeRatings,
  matchAnimeRating,
  parseMalRanking,
} from "../src/anime-ratings.js";
import { createArtwork } from "../src/artwork.js";

const testTitle = "示例动画 第二季";
const bangumi = {
  id: 10,
  type: 2,
  name: "Sample Anime Season 2",
  name_cn: testTitle,
  date: "2025-01-01",
  platform: "TV",
  rating: { score: 8.6, rank: 12, total: 100 },
};
const anilist = {
  id: 11,
  idMal: 12,
  title: { english: "Sample Anime Season 2" },
  synonyms: [testTitle],
  format: "TV",
  averageScore: 88,
  startDate: { year: 2025 },
  stats: { scoreDistribution: [{ amount: 12 }, { amount: 130 }] },
};
const detail =
  '<h1 class="title-name">Sample Anime Season 2</h1><span itemprop="ratingValue">8.75</span><span itemprop="ratingCount">1,234</span>';

test("exact title matching distinguishes season, year, format and ambiguous homonyms", () => {
  const tv = {
    id: "1",
    names: ["示例动画 第二季", "Sample Anime 2nd Season"],
    year: "2025",
    format: "tv",
  };
  const movie = {
    id: "2",
    names: ["示例动画 第二季"],
    year: "2024",
    format: "movie",
  };
  const first = {
    id: "3",
    names: ["示例动画", "Sample Anime"],
    year: "2023",
    format: "tv",
  };
  assert.equal(
    matchAnimeRating([tv, movie, first], {
      title: "示例動畫 S02",
      format: "tv",
    })?.id,
    "1",
  );
  assert.equal(
    matchAnimeRating([tv, movie, first], { title: "Sample Anime" })?.id,
    "3",
  );
  assert.equal(
    matchAnimeRating([tv, movie], { title: "示例动画 第二季" }),
    null,
  );
});

test("four rating providers preserve native scales, real vote counts and a partial outage", async () => {
  const calls = [];
  let offline = false;
  const service = createAnimeRatings(() => ({}), {
    network: {
      async read(url, options) {
        calls.push(url);
        const text = (value) => ({ text: JSON.stringify(value) });
        if (url.endsWith("/v0/subjects/10")) return text(bangumi);
        if (url === "https://graphql.anilist.co/") {
          assert.match(options.jsonBody.query, /Media\(id:/);
          return text({ data: { Media: anilist } });
        }
        if (url.endsWith("/anime/12")) return { text: detail };
        if (url.includes("subject_suggest")) {
          if (offline) throw Error("offline");
          return text([{ id: "13", title: testTitle, year: "2025" }]);
        }
        assert.match(url, /subject_abstract\?subject_id=13$/);
        return text({
          subject: {
            id: "13",
            title: testTitle,
            types: ["动画"],
            is_tv: true,
            rate: "9.0",
          },
        });
      },
    },
  });
  const work = { title: testTitle, ids: { bangumi: "10", anilist: "11" } };
  const { results } = await service.lookup(work);
  assert.deepEqual(
    results.map((row) => [
      row.source,
      row.rating.score,
      row.rating.scale,
      row.rating.votes,
    ]),
    [
      ["bangumi", 8.6, 10, 100],
      ["mal", 8.75, 10, 1234],
      ["anilist", 88, 100, 142],
      ["douban", 9, 10, null],
    ],
  );
  const count = calls.length;
  await service.lookup(work);
  assert.equal(calls.length, count);
  offline = true;
  assert.deepEqual(
    (await service.lookup(work, true)).results.map((row) => row.state),
    ["matched", "matched", "matched", "unavailable"],
  );
});

test("MAL ranking uses rank and rating rather than the number of members", () => {
  const [row] = parseMalRanking(
    '<table><tr class="ranking-list"><td class="rank">26</td><td><h3><a href="https://myanimelist.net/anime/12/Demo">Demo</a></h3><div class="information">TV (12 eps)<br>Oct 2025<br>100 members</div></td><td class="score"><span class="score-label">8.7</span></td></tr></table>',
  );
  assert.deepEqual(
    [row.rank, row.score, row.votes, row.year],
    [26, 8.7, null, "2025"],
  );
});

test("ranking artwork allows validated poster paths only", () => {
  const artwork = createArtwork(() => ({}));
  assert.match(
    artwork.register("https://lain.bgm.tv/r/400/pic/cover/l/demo.jpg").src,
    /^\/covers\//,
  );
  assert.match(
    artwork.register("https://cdn.myanimelist.net/images/anime/1/2.jpg").src,
    /^\/covers\//,
  );
  assert.throws(() =>
    artwork.register("https://cdn.myanimelist.net/other/image.jpg"),
  );
});

test("MAL ranking rewrites signed thumbnail URLs to the official full-size anime cover", () => {
  const [row] = parseMalRanking(`
    <table><tr class="ranking-list">
      <td class="rank">1</td>
      <td><img src="/placeholder.png" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/1015/138006.jpg?s=09c2f2">
      <h3><a href="https://myanimelist.net/anime/52991">Frieren</a></h3></td>
      <td class="score"><span class="score-label">9.2</span></td>
    </tr></table>`);
  assert.equal(
    row.cover,
    "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
  );
  assert.match(
    createArtwork(() => ({})).register(row.cover).src,
    /^\/covers\//,
  );
});
