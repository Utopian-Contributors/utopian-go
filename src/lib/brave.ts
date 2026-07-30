import {
  BRAVE_API_KEY,
  BRAVE_ENDPOINT,
  BRAVE_IMAGES_ENDPOINT,
} from "../config";
import { plainText } from "./text";
import {
  BraveImageSearchResponse,
  BraveSearchResponse,
  DiscussionItem,
  FaqItem,
  ImageItem,
  ImageSearchApiResponse,
  Infobox,
  MetaUrl,
  NewsItem,
  SearchApiResponse,
  VideoItem,
  WebResult,
} from "../types";

export class BraveApiError extends Error {}

async function braveFetch(url: string): Promise<unknown> {
  if (!BRAVE_API_KEY) {
    throw new BraveApiError("No BRAVE_API_KEY set on the server.");
  }

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
  });

  if (!res.ok) {
    throw new BraveApiError(`Brave API responded ${res.status}`);
  }

  return res.json();
}

export async function braveSearch(query: string): Promise<SearchApiResponse> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=10`;
  const data = (await braveFetch(url)) as BraveSearchResponse;
  return normalize(query, data);
}

export async function braveImageSearch(
  query: string,
): Promise<ImageSearchApiResponse> {
  const url =
    `${BRAVE_IMAGES_ENDPOINT}?q=${encodeURIComponent(query)}&count=20`;
  const data = (await braveFetch(url)) as BraveImageSearchResponse;

  const images: ImageItem[] = (data.results ?? [])
    .map((r) => {
      const item: ImageItem = {
        title: plainText(r.title ?? ""),
        url: r.url ?? "",
      };
      if (r.source) item.source = plainText(r.source);
      else if (r.meta_url?.netloc) item.source = plainText(r.meta_url.netloc);
      if (r.thumbnail?.src) item.thumbnail = r.thumbnail.src;
      if (r.properties?.url) item.image = r.properties.url;
      const w = r.properties?.width ?? r.thumbnail?.width;
      const h = r.properties?.height ?? r.thumbnail?.height;
      if (w) item.width = w;
      if (h) item.height = h;
      return item;
    })
    .filter((i) => i.url && (i.thumbnail || i.image));

  return { query, images };
}

function meta(m?: {
  netloc?: string;
  path?: string;
}): MetaUrl | undefined {
  if (!m) return undefined;
  return {
    ...(m.netloc ? { netloc: plainText(m.netloc) } : {}),
    ...(m.path ? { path: plainText(m.path) } : {}),
  };
}

/**
 * Clean one infobox attribute row. Returns null to drop section headers,
 * empty values, and non-string junk.
 */
function normalizeInfoboxAttr(
  pair: unknown,
): [string, string] | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const rawK = pair[0];
  const rawV = pair[1];
  // Section headers ship as null/undefined (not useful as table rows)
  if (rawV == null) return null;
  if (typeof rawV === "object") return null;

  let k = plainText(String(rawK ?? ""));
  let v = plainText(String(rawV));
  if (!k || !v) return null;
  if (/^(null|undefined)$/i.test(v)) return null;

  // "Developer (s)" → "Developer(s)" (space left by stripped tags)
  k = k.replace(/\s+\(/g, "(");
  // Collapse leftover spaces around punctuation from markup strip
  v = v.replace(/\s+([,;:.])/g, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

  return [k, v];
}

/** Snippets may keep <strong> for highlights; everything else is plain. */
function snippetText(value: string = ""): string {
  // Protect allowlisted highlight tags, strip/decode the rest, restore tags.
  // Do not trim each segment — spaces next to <strong> must survive.
  const raw = String(value);
  const parts = raw.split(/(<\/?strong>)/gi);
  return parts
    .map((part) => {
      if (/^<\/?strong>$/i.test(part)) return part.toLowerCase();
      return plainText(part, { trim: false });
    })
    .join("")
    .trim(); // only the full snippet, not segments
}

function normalize(query: string, data: BraveSearchResponse): SearchApiResponse {
  const results: WebResult[] = (data.web?.results ?? []).map((r) => {
    const item: WebResult = {
      title: plainText(r.title ?? ""),
      url: r.url ?? "",
      description: snippetText(r.description ?? ""),
    };
    if (r.profile?.name) {
      item.profile = { name: plainText(r.profile.name) };
    }
    const m = meta(r.meta_url);
    if (m && Object.keys(m).length) item.meta_url = m;
    const cluster = (r.cluster ?? [])
      .slice(0, 4)
      .map((c) => ({
        title: plainText(c.title ?? ""),
        url: c.url ?? "",
        ...(c.description
          ? { description: snippetText(c.description) }
          : {}),
      }))
      .filter((c) => c.title && c.url);
    if (cluster.length) item.cluster = cluster;
    const age = r.page_age || r.age;
    if (age) item.age = age;
    return item;
  });

  const rawBox = data.infobox?.results?.[0];
  let infobox: Infobox | undefined;
  if (rawBox?.title) {
    const thumb =
      rawBox.images?.find((i) => i.src)?.src || rawBox.thumbnail?.src;
    // Brave uses null values for Wikipedia-style section headers
    // (e.g. ["<strong>Denominations</strong>", null]). Drop those; they
    // otherwise become the literal string "null" after plainText.
    const attributes = (rawBox.attributes ?? [])
      .map((pair) => normalizeInfoboxAttr(pair))
      .filter((row): row is [string, string] => row != null)
      .slice(0, 10);
    const profiles = (rawBox.profiles ?? [])
      .slice(0, 6)
      .filter((p) => p.url)
      .map((p) => ({
        ...(p.name ? { name: plainText(p.name) } : {}),
        url: p.url,
      }));

    infobox = {
      title: plainText(rawBox.title),
      ...(rawBox.description
        ? { description: plainText(rawBox.description) }
        : {}),
      ...(rawBox.long_desc
        ? { long_desc: plainText(rawBox.long_desc) }
        : {}),
      ...(rawBox.category ? { category: plainText(rawBox.category) } : {}),
      ...(thumb ? { thumbnail: thumb } : {}),
      ...(attributes.length ? { attributes } : {}),
      ...(profiles.length ? { profiles } : {}),
    };
  }

  const faq: FaqItem[] | undefined = data.faq?.results
    ?.slice(0, 4)
    .map((f) => ({
      question: plainText(f.question ?? ""),
      answer: plainText(f.answer ?? ""),
    }))
    .filter((f) => f.question);

  const news: NewsItem[] | undefined = data.news?.results
    ?.slice(0, 8)
    .map((n) => {
      const item: NewsItem = {
        title: plainText(n.title ?? ""),
        url: n.url ?? "",
      };
      if (n.description) item.description = snippetText(n.description);
      if (n.page_age) item.age = n.page_age;
      const m = meta(n.meta_url);
      if (m && Object.keys(m).length) item.meta_url = m;
      return item;
    })
    .filter((n) => n.title && n.url);

  const videos: VideoItem[] | undefined = data.videos?.results
    ?.slice(0, 8)
    .map((v) => {
      const item: VideoItem = {
        title: plainText(v.title ?? ""),
        url: v.url ?? "",
      };
      if (v.description) item.description = snippetText(v.description);
      const m = meta(v.meta_url);
      if (m && Object.keys(m).length) item.meta_url = m;
      if (v.thumbnail?.src) item.thumbnail = { src: v.thumbnail.src };
      return item;
    })
    .filter((v) => v.title && v.url);

  const discussions: DiscussionItem[] | undefined = data.discussions?.results
    ?.slice(0, 8)
    .map((d) => {
      const item: DiscussionItem = {
        title: plainText(d.title ?? ""),
        url: d.url ?? "",
      };
      if (d.description) item.description = snippetText(d.description);
      const m = meta(d.meta_url);
      if (m && Object.keys(m).length) item.meta_url = m;
      return item;
    })
    .filter((d) => d.title && d.url);

  return {
    query,
    results,
    ...(infobox ? { infobox } : {}),
    ...(faq?.length ? { faq } : {}),
    ...(news?.length ? { news } : {}),
    ...(videos?.length ? { videos } : {}),
    ...(discussions?.length ? { discussions } : {}),
  };
}
