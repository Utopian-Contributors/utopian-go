#!/usr/bin/env node
/**
 * The app's coloured marks: client/ic-*.svg, each one an icon out of the
 * skeu-icons package, written out as a file of its own.
 *
 * Run by hand (`npm run build:skeu`), not on every client build — the same
 * arrangement as app-icons.mjs, which it runs afterwards so the wallet and
 * social pages' PNG tab icons follow their drawings. The output is checked in;
 * `copyStatic` in build-client.mjs ships it to public/.
 *
 * Files rather than the package's createIcons(): the marks are stylesheet
 * backgrounds (`--ic: url(...)`), <img>s and favicons, none of which can hold
 * an inline <svg>, and as files they cost the pages no script. A file is its
 * own document, so the package's gradient ids cannot meet another copy's and
 * need none of the per-instance renaming createElement() does.
 */
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "client");

/** Each file the app points at, and the skeu-icons name drawn into it. */
const MARKS = {
  "ic-add": "user-plus",
  "ic-bell": "bell",
  "ic-cash": "banknote",
  "ic-chat": "message-circle",
  "ic-edit": "pencil",
  "ic-failed": "circle-alert",
  "ic-friend": "user-check",
  "ic-home": "house",
  "ic-link": "link",
  "ic-minus": "minus",
  "ic-more": "ellipsis",
  "ic-person": "user",
  "ic-plus": "plus",
  "ic-receive": "download",
  "ic-send": "upload",
  "ic-social": "users",
  "ic-swap": "arrow-right-left",
  "ic-wallet": "wallet",
  "ic-wand": "wand-sparkles",
};

/** @param {string} value */
const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * An IconNode — [tag, attrs, children?] all the way down — as markup.
 * @param {[string, Record<string, string>, any[]?][]} node
 * @returns {string}
 */
function markup(node) {
  return node
    .map(([tag, attrs, children]) => {
      const open = tag + Object.entries(attrs).map(([k, v]) => ` ${k}="${escape(String(v))}"`).join("");
      return children ? `<${open}>${markup(children)}</${tag}>` : `<${open}/>`;
    })
    .join("");
}

for (const [file, name] of Object.entries(MARKS)) {
  const { default: icon } = await import(`skeu-icons/icons/${name}`);
  // The root the old drawings had: no size of its own, so a stylesheet or an
  // <img> sizes it, and app-icons.mjs can still give it one.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${markup(icon)}</svg>\n`;
  writeFileSync(path.join(clientDir, `${file}.svg`), svg);
  console.log(`${`${file}.svg`.padEnd(16)} ${name.padEnd(18)} ${String(svg.length).padStart(5)} B`);
}
