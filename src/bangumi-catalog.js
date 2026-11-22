const base = "https://api.bgm.tv";
const defaults = { maxBytes: 1_000_000, timeoutMs: 4500 };

export function bangumiNames(item) {
  const aliases =
    item.infobox
      ?.filter((field) => ["别名", "中文名"].includes(field.key))
      .flatMap((field) =>
        Array.isArray(field.value)
          ? field.value.map((entry) => entry?.v)
          : [field.value],
      ) || [];
  return [item.name_cn, item.name, ...aliases].filter(
    (name) => typeof name === "string" && name.trim(),
  );
}

export async function searchBangumi(network, keyword) {
  const response = await network.read(base + "/v0/search/subjects?limit=8", {
    ...defaults,
    jsonBody: { keyword, sort: "match", filter: { type: [2], nsfw: false } },
  });
  const data = JSON.parse(response.text).data;
  if (!Array.isArray(data)) throw Error("Bangumi 暂未返回作品搜索结果。");
  return data.filter(
    (row) => row.type === 2 && Number.isSafeInteger(row.id) && row.id > 0,
  );
}

export async function readBangumi(network, id) {
  if (!/^\d{1,10}$/.test(String(id))) throw Error("Bangumi 作品编号无效。");
  const item = JSON.parse(
    (await network.read(base + "/v0/subjects/" + id, defaults)).text,
  );
  if (item.type !== 2) return null;
  return item;
}

export async function findBangumi(network, keyword, match) {
  const results = await searchBangumi(network, keyword);
  const matchByTitle = match(results);
  if (matchByTitle) return matchByTitle;
  // Search results can omit alternate translations. Verify only the best
  // candidates against the aliases published on their subject pages.
  const details = await Promise.allSettled(
    results.slice(0, 3).map((row) => readBangumi(network, row.id)),
  );
  if (details.length && details.every((result) => result.status === "rejected"))
    throw details[0].reason;
  return match(
    details.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    ),
  );
}
