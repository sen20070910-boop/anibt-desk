import { load } from "cheerio/slim";
import {
  hasMultipleSubtitles,
  hasSubtitleExtension,
  sidecarLanguage,
  subtitleLanguageCode,
  subtitleList,
  titleSubtitleCodes,
} from "./subtitle-language.js";

export function nyaaSubtitlePage(item) {
  const candidates = [
    item.pageUrl,
    ...(item.links || []).map((link) => link.url),
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (
        url.origin === "https://nyaa.si" &&
        !url.username &&
        !url.password &&
        /^\/view\/\d+$/.test(url.pathname)
      )
        return url.origin + url.pathname;
    } catch {}
  }
  return "";
}

export function readNyaaSubtitleDetails(html) {
  const $ = load(html);
  const description = $("#torrent-description");
  if (!description.length) throw new Error("发布页未返回可识别的详情。");
  const body = description.text().slice(0, 32000);
  const languages = new Set(),
    sidecars = new Set();
  let subtitleSection = false;
  for (const line of body.split(/\r?\n/)) {
    const plain = line.replace(/[*_`]/g, "").trim();
    if (/^(?:audio|video|general|chapters?|attachments?)\b/i.test(plain))
      subtitleSection = false;
    const label = plain.match(
      /^(?:\|\s*)?(?:subtitles?|text)\b(?:[ -]*(?:track[ -]*)?\d+)?\s*[:|]?\s*(.*)$/i,
    );
    if (label) subtitleSection = true;
    if (label?.[1])
      for (const code of subtitleList(label[1])) languages.add(code);
    if (subtitleSection) {
      const field = plain.match(/^language\s*:\s*(.+)$/i);
      const entry = plain.match(/^\d+[.)]\s+(.+)$/);
      if (field || entry)
        for (const code of subtitleList((field || entry)[1]))
          languages.add(code);
    }
    const explicit = plain.match(/\bsubtitle\b.*\{([a-z-]{2,12})\}\s*$/i);
    if (explicit) {
      const code = subtitleLanguageCode(explicit[1]);
      if (code) languages.add(code);
    }
    const inline = plain.match(
      /(?:^|[:|]\s*)([a-z]+)\s+(?:subtitles?|subs)\b/i,
    );
    if (inline) {
      const code = subtitleLanguageCode(inline[1]);
      if (code) languages.add(code);
    }
  }
  $(".torrent-file-list li").each((_, node) => {
    if ($(node).children("ul").length) return;
    const name = $(node)
      .contents()
      .filter((_, part) => part.type === "text")
      .text()
      .trim();
    if (!hasSubtitleExtension(name)) return;
    const code = sidecarLanguage(name);
    if (code) sidecars.add(code);
  });
  return {
    languages: [...languages],
    sidecars: [...sidecars],
    multiple: hasMultipleSubtitles(body),
    hasSubtitles:
      /\bsubtitle\s+track\s+\d+\b/i.test(body) ||
      sidecars.size > 0 ||
      languages.size > 0,
  };
}
