/**
 * Result language — the footer control, the stored preference, and the code
 * every request carries.
 *
 * The fifty languages are not listed here. They are the <option> list the
 * shell ships, because a kilobyte of native names fits the document's budget
 * and does not fit this bundle's (see PAGES in scripts/build-client.mjs). So
 * on this side the control *is* the allowlist: anything reaching setLang is
 * measured against the options actually offered. src/lib/lang.ts holds the
 * authoritative table and answers an unknown code with English, so the two
 * drifting apart costs a default rather than a failed search.
 */
import { $ } from "./dom.js";

/** Brave's own default, and the first <option> the shell ships. */
export const DEFAULT_LANG = "en";

const STORE_KEY = "ug.lang";

/** @type {HTMLSelectElement} */
let sel;
let current = DEFAULT_LANG;

/**
 * Whether the shell offers this code.
 * @param {string} code
 */
function offered(code) {
  if (!code) return false;
  for (const opt of sel.options) if (opt.value === code) return true;
  return false;
}

/**
 * localStorage throws rather than returning null where it is unavailable —
 * Safari's private mode, a blocked third-party context. A remembered language
 * is not worth a page that fails to boot.
 */
function stored() {
  try {
    return localStorage.getItem(STORE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Stamp the language onto the panes the results land in.
 *
 * Not decoration. `lang` is what picks the glyphs — a Han character is drawn
 * differently in Japanese and in Chinese, and the tag is the only thing that
 * tells a browser which of the two it is looking at — and it is what lets one
 * break lines in Thai and CJK, which have no spaces to break on. Without it a
 * Japanese SERP is set in Chinese letterforms and wraps mid-word.
 *
 * The tag is BCP-47, which is not always Brave's code. They agree on 49 of the
 * 50; Brave spells Japanese `jp`, which in HTML is the *country* Japan and
 * says nothing about language. That option carries the real tag in `data-l`.
 * The rest are already valid — BCP-47 matching is case-insensitive, so
 * `zh-hans` and `pt-br` are read exactly as `zh-Hans` and `pt-BR` are.
 *
 * Only the result panes, never the document: the interface around them is in
 * English whatever the results are in, and an <html lang> covering both would
 * be a claim about the wrong half of the page.
 */
function apply() {
  const opt = sel.selectedOptions[0];
  const tag = (opt && opt.dataset.l) || current;
  $("rs").lang = tag;
  $("sd").lang = tag;
}

/** The language in force. */
export function currentLang() {
  return current;
}

/**
 * `&lang=…` for a request, or nothing when English is in force.
 *
 * Unescaped because it cannot need escaping: the value is always one of the
 * option values in our own markup, which are ASCII letters and one hyphen.
 */
export function langParam() {
  return current === DEFAULT_LANG ? "" : `&lang=${current}`;
}

/**
 * Point the control at a language, if it is one we offer.
 *
 * @param {string} code
 * @returns {boolean} whether this moved it
 */
export function setLang(code) {
  const next = offered(code) ? code : DEFAULT_LANG;
  if (next === current) return false;
  current = next;
  sel.value = next;
  apply();
  return true;
}

/**
 * Wire the footer control.
 *
 * Precedence is the URL, then the stored preference, then English: a shared
 * SERP link has to open in the language it was shared in, whatever the person
 * opening it last picked here. Only an explicit pick is written back — a link
 * someone followed is not a preference they expressed.
 *
 * @param {string} fromUrl the language named by ?lang=, "" if none
 * @param {() => void} onPick
 */
export function mountLang(fromUrl, onPick) {
  sel = /** @type {HTMLSelectElement} */ ($("lang"));
  current = [fromUrl, stored()].find(offered) || DEFAULT_LANG;
  sel.value = current;
  apply();
  sel.addEventListener("change", () => {
    if (!setLang(sel.value)) return;
    try {
      localStorage.setItem(STORE_KEY, current);
    } catch {
      // Unavailable storage is not a reason to refuse the language.
    }
    onPick();
  });
}
