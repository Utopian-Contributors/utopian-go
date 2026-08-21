/**
 * The language a search is answered in.
 *
 * Three Brave parameters rather than one, because one does not pin a result.
 * `search_lang` picks the language of the indexed content, `country` picks
 * which regional index it comes from, and `ui_lang` picks the language of the
 * metadata Brave wraps around it. Send only the first and the other two are
 * still inferred from this server's egress IP — which is how a site labelled
 * in English came to serve German infoboxes. Every worked example in
 * normalizeInfoboxAttr (lib/brave.ts) was written against one: "14. Oktober
 * 2007", "über 450.000 ()", "Rammstein auf dem Wacken Open Air (2013)". The
 * address a deploy happens to egress from is not a statement about what the
 * person searching wants to read.
 */

/** Where a language is read, in the two vocabularies Brave has for it. */
type Market = {
  /** Brave `country`, where one of its 36 covers this language. */
  readonly country?: string;
  /** Brave `ui_lang`, where one of its 38 markets speaks it. */
  readonly ui?: string;
};

/**
 * Brave's 50 `search_lang` codes, each with the market it belongs to.
 *
 * A Map rather than a bare object because this table is also the allowlist:
 * `MARKETS[code]` on an object literal answers for `constructor` and
 * `__proto__` as readily as for `de`, and the code being tested against it
 * arrives in a query string. `has` answers about entries only.
 *
 * Keys are Brave's spellings, not ISO's — Japanese is `jp` here and `ja` in
 * the `ui_lang` it maps to. Not every language it indexes has a market to pair
 * with it (50 languages, 38 markets), so the empty rows are deliberate: Thai,
 * Ukrainian and Hebrew send the language alone and leave the rest to Brave,
 * which is still a better answer than the deploy's IP. The regional languages
 * of Spain take the Spanish index without the Spanish interface, and the
 * languages of India take the Indian one — a market is the nearest thing Brave
 * offers to "where this is read".
 *
 * The <select> in client/index.html is the visible half of this table and is
 * edited with it. Drift is survivable in both directions by construction: a
 * code offered there and missing here falls back to English rather than
 * reaching Brave, and a code here and missing there is simply never asked for.
 */
const MARKETS = new Map<string, Market>(
  Object.entries({
    ar: { country: "SA" },
    eu: { country: "ES" },
    bn: {},
    bg: {},
    ca: { country: "ES" },
    "zh-hans": { country: "CN", ui: "zh-CN" },
    "zh-hant": { country: "TW", ui: "zh-TW" },
    hr: {},
    cs: {},
    da: { country: "DK", ui: "da-DK" },
    nl: { country: "NL", ui: "nl-NL" },
    en: { country: "US", ui: "en-US" },
    "en-gb": { country: "GB", ui: "en-GB" },
    et: {},
    fi: { country: "FI", ui: "fi-FI" },
    fr: { country: "FR", ui: "fr-FR" },
    gl: { country: "ES" },
    de: { country: "DE", ui: "de-DE" },
    gu: { country: "IN" },
    he: {},
    hi: { country: "IN" },
    hu: {},
    is: {},
    it: { country: "IT", ui: "it-IT" },
    jp: { country: "JP", ui: "ja-JP" },
    kn: { country: "IN" },
    ko: { country: "KR", ui: "ko-KR" },
    lv: {},
    lt: {},
    ms: { country: "MY" },
    ml: { country: "IN" },
    mr: { country: "IN" },
    nb: { country: "NO", ui: "no-NO" },
    pl: { country: "PL", ui: "pl-PL" },
    "pt-br": { country: "BR", ui: "pt-BR" },
    "pt-pt": { country: "PT" },
    pa: { country: "IN" },
    ro: {},
    ru: { country: "RU", ui: "ru-RU" },
    sr: {},
    sk: {},
    sl: {},
    es: { country: "ES", ui: "es-ES" },
    sv: { country: "SE", ui: "sv-SE" },
    ta: { country: "IN" },
    te: { country: "IN" },
    th: {},
    tr: { country: "TR", ui: "tr-TR" },
    uk: {},
    vi: {},
  }),
);

/** Brave's own default, and what anything unrecognised falls back to. */
export const DEFAULT_LANG = "en";

/** Whether Brave indexes this language. */
export function isLanguage(code: string): boolean {
  return MARKETS.has(code);
}

/**
 * Brave's language parameters for one code, ready to append to a query string.
 *
 * Nothing here is escaped and nothing here needs to be: every value is a
 * literal from the table above. A code that arrived in a request reached this
 * through readLang in routes/api.ts, which answers with one of these keys or
 * with the default — it never forwards what it was given.
 *
 * @param ui whether to ask for `ui_lang` as well. The images endpoint
 *   documents `country` and `search_lang` only, so it is sent neither more nor
 *   less than it takes.
 */
export function langQuery(code: string, ui = false): string {
  const lang = MARKETS.has(code) ? code : DEFAULT_LANG;
  const market = MARKETS.get(lang) ?? {};
  let qs = `&search_lang=${lang}`;
  if (market.country) qs += `&country=${market.country}`;
  if (ui && market.ui) qs += `&ui_lang=${market.ui}`;
  return qs;
}
