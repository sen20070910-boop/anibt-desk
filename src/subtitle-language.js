const aliases = new Map([
  [
    "CHS",
    "sc chs gb gb2312 zh-hans zh-cn zh-sg simplified chinese-simplified 简体 简体中文 简中 简体中字 簡體 簡體中文 簡中",
  ],
  [
    "CHT",
    "tc cht big5 zh-hant zh-tw zh-hk zh-mo traditional chinese-traditional 繁体 繁體 繁体中文 繁體中文 繁中",
  ],
  ["ZH", "zh chi zho cmn chinese 中文 中字"],
  ["EN", "en eng english 英语 英語 英文"],
  ["IT", "it ita italian 意大利语 義大利語"],
  ["JA", "ja jp jpn japanese 日语 日語 日文"],
  ["KO", "ko kor korean 韩语 韓語"],
  ["FR", "fr fre fra french 法语 法語"],
  ["DE", "de ger deu german 德语 德語"],
  ["ES", "es esp spa spanish 西班牙语 西班牙語"],
  ["PT", "pt por portuguese 葡萄牙语 葡萄牙語"],
  ["RU", "ru rus russian 俄语 俄語"],
  ["AR", "ar ara arabic 阿拉伯语 阿拉伯語"],
  ["TH", "th tha thai 泰语 泰語"],
  ["VI", "vi vie vietnamese 越南语 越南語"],
  ["ID", "id ind indonesian 印尼语 印尼語"],
]);

const codes = new Map(
  [...aliases].flatMap(([code, values]) =>
    values.split(" ").map((value) => [value, code]),
  ),
);

export function subtitleLanguageCode(value) {
  const tag = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (/^(?:zh|cmn)-(?:hans|cn|sg)(?:-|$)/.test(tag)) return "CHS";
  if (/^(?:zh|cmn)-(?:hant|tw|hk|mo)(?:-|$)/.test(tag)) return "CHT";
  return codes.get(tag) || codes.get(tag.split("-")[0]) || "";
}

const languageNames = new Intl.DisplayNames("zh-CN", {
  type: "language",
  fallback: "none",
});

export function subtitleLanguageName(code) {
  if (code === "CHS") return "简中";
  if (code === "CHT") return "繁中";
  if (code === "ZH") return "中文（简繁未标注）";
  if (!code) return "语言未标注";
  return languageNames.of(code.toLowerCase()) || code;
}

export function hasVideoExtension(name) {
  return /\.(?:mkv|mp4|m4v|avi|webm|mov|wmv|ts|m2ts)$/i.test(name);
}

export function hasSubtitleExtension(name) {
  return /\.(?:ass|ssa|srt|vtt|sup|sub|idx)$/i.test(name);
}

export function sidecarLanguageInfo(name) {
  const stem = String(name)
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC");
  // A code near the end is a subtitle suffix; a short word in the movie title is not.
  const suffix = stem.match(
    /(?:^|[\s._[(\]-])((?:zh|cmn)[-_](?:hans|hant|cn|tw|sg|hk|mo)(?:[-_][a-z]{2})?|[\w\u3400-\u9fff]+)[\])]?$/i,
  )?.[1];
  const paired = suffix?.match(
    /^(?:(?:jp|jpn|ja)(sc|chs|tc|cht)|(sc|chs|tc|cht)(?:jp|jpn|ja))$/i,
  );
  if (paired) {
    const code = subtitleLanguageCode(paired[1] || paired[2]);
    return { code, label: subtitleLanguageName(code) + " / 日文" };
  }
  const explicitChinese =
    stem.match(
      /简体中文|簡體中文|繁体中文|繁體中文|简[体中]|簡[體中]|繁[体體中]/,
    )?.[0] ||
    (/简[日繁]|簡[日繁]/.test(stem) ? "chs" : /繁日/.test(stem) ? "cht" : "");
  const boundedCode = stem.match(
    /(?:^|[.\s_[(\]-])(chs|cht|sc|tc|gb(?:2312)?|big5)(?=[.\s_\])\-])/i,
  )?.[1];
  const code = subtitleLanguageCode(explicitChinese || boundedCode || suffix);
  return { code, label: subtitleLanguageName(code) };
}

export const sidecarLanguage = (name) => sidecarLanguageInfo(name).code;

export function titleSubtitleCodes(text) {
  const languages = new Set();
  for (const match of text.matchAll(
    /\b(?:subs?|subtitles?)[.:_ -]+([\w\u3400-\u9fff]+(?:[-.:_ +/,&]+[\w\u3400-\u9fff]+)*)/gi,
  )) {
    const tokens = match[1].match(
      /(?:zh|cmn)[-_](?:hans|hant|cn|tw|sg|hk|mo)|[\w\u3400-\u9fff]+/gi,
    );
    for (const token of tokens) {
      const code = subtitleLanguageCode(token);
      if (!code) break;
      languages.add(code);
    }
  }
  for (const region of text.matchAll(/[\[({]([^\])}\r\n]{1,150})[\])}]/g)) {
    const ending = region[1].match(/^(.+?)[. _-]+(?:subs?|subtitles?)$/i);
    if (ending) for (const code of subtitleList(ending[1])) languages.add(code);
  }
  if (/\bVOST[ ._-]*FR\b/i.test(text)) languages.add("FR");
  return [...languages];
}

export function subtitleList(text) {
  const tokens =
    text.match(
      /(?:zh|cmn)[-_](?:hans|hant|cn|tw|sg|hk|mo)|[a-z\u3400-\u9fff0-9]+/gi,
    ) || [];
  const found = new Set();
  for (const token of tokens) {
    const code = subtitleLanguageCode(token);
    if (!code) break;
    found.add(code);
  }
  return [...found];
}

export function hasMultipleSubtitles(text) {
  return /\b(?:multi(?:ple|lingual)?[ \t._-]+(?:subs|subtitles)\b|multi[ ._-]*subs\b)|多[国语國語]字幕/i.test(
    text,
  );
}
