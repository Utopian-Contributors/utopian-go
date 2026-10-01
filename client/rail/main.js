/**
 * The desktop timeline's right column: people worth adding, then what is
 * trading on Solana today.
 *
 * Its own bundle, fetched by social.js only where the column shows (a screen
 * 901px or wider), so a phone downloads neither this nor the data it asks
 * for. Where the column sits is social.css's; what is inside it is styled
 * here, for the same reason.
 */
import { coinIcon } from "../js/coin.js";
import { el } from "../js/dom.js";
import { fiat, percent, tokenPrice } from "../js/num.js";
import { injectStyles } from "../js/ui.js";

const CSS = `
.rl-s{margin:0 0 28px}
.rl-s h2{margin:0 0 6px;font:700 15px/1.3 var(--ff);color:var(--t)}
.rl ul,.rl ol{margin:0;padding:0;list-style:none}
.rl li{display:flex;align-items:center;gap:10px;min-height:52px}
.rl-who,.rl-tk{display:flex;align-items:center;gap:10px;flex:1;min-width:0;color:inherit;text-decoration:none}
.rl-who:hover,.rl-tk:hover{color:inherit;text-decoration:none}
.rl-who:hover b,.rl-tk:hover b{text-decoration:underline}
.rl-who .mini{flex:none;width:36px}
.rl-id{min-width:0}
.rl b{display:block;overflow:hidden;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.rl small{display:block;color:var(--f);font-size:12px;line-height:1.4}
.rl-ic{flex:none;width:28px;height:28px;border-radius:50%}
.rl-coin{display:inline-flex;align-items:center;justify-content:center;padding-bottom:1px;background:var(--b);
 color:var(--m);font-size:13px;font-weight:600;line-height:1;user-select:none}
.rl-q{margin-left:auto;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rl .up{color:var(--go)}
.rl .dn{color:var(--dn)}
.rl-add{flex:none;height:30px;padding:0 14px;border:1px solid var(--go);border-radius:999px;background:none;
 color:var(--go);font:600 13px/1 var(--ff);cursor:pointer}
.rl-add:hover:not(:disabled){background:var(--go);color:var(--go-ink)}
.rl-add:focus-visible{outline:2px solid var(--go);outline-offset:2px}
.rl-add:disabled{border-color:var(--b);color:var(--f);cursor:default}
@media (max-width:900px){.rl{display:none}}
`;

/** The most active people, less the viewer and whoever they already added. Add asks to log in first. */
function people(list, { send, face, openAuth, me }) {
  if (!list.length) return null;
  const rows = list.map((person) => {
    const add = el("button", { type: "button", class: "rl-add", text: "Add", "aria-label": `Add ${person.name}` });
    add.addEventListener("click", async () => {
      if (!me()) return openAuth("login");
      add.disabled = true;
      try {
        await send("/api/social/friends", { username: person.name });
        add.textContent = "Added";
      } catch (cause) {
        // The label says why for a moment, then goes back to what the button does.
        add.textContent = cause.message;
        setTimeout(() => {
          add.textContent = "Add";
          add.disabled = false;
        }, 3000);
      }
    });
    return el(
      "li",
      {},
      el(
        "a",
        { class: "rl-who", href: `/social/u/${person.name}` },
        face(person.name, person.avatarRev),
        el(
          "span",
          { class: "rl-id" },
          el("b", { text: person.name }),
          el("small", { text: person.posts === 1 ? "1 post this month" : `${person.posts} posts this month` }),
        ),
      ),
      add,
    );
  });
  return el(
    "section",
    { class: "rl-s", "aria-labelledby": "rl-p" },
    el("h2", { id: "rl-p", text: "Friends to add" }),
    el("ul", {}, ...rows),
  );
}

/** Most traded first, stablecoins left out by the server. Each opens its chart on the wallet page. */
function assets(list) {
  if (!list.length) return null;
  const rows = list.map((token) => {
    const price = tokenPrice(token.price);
    const move = token.change24h;
    return el(
      "li",
      {},
      el(
        "a",
        // By mint, not symbol: symbols collide, and the panel answers for a mint.
        { class: "rl-tk", href: `/wallet?t=${encodeURIComponent(token.mint)}`, title: token.name },
        coinIcon(token, 28, "rl-ic", "rl-coin"),
        el("span", { class: "rl-id" }, el("b", { text: token.symbol }), el("small", { text: `${fiat(token.volume)} traded` })),
        el(
          "span",
          { class: "rl-q" },
          el("span", { text: price.text, title: price.title, "aria-label": price.label }),
          move == null ? null : el("small", { class: move > 0 ? "up" : move < 0 ? "dn" : "", text: percent(move, true) }),
        ),
      ),
    );
  });
  return el(
    "section",
    { class: "rl-s", "aria-labelledby": "rl-a" },
    el("h2", { id: "rl-a", text: "Trending assets" }),
    el("ol", {}, ...rows),
  );
}

/**
 * Appends the column to `side` and fills it when the answer comes. Whatever
 * redraws the side first takes the box with it, and the late answer is dropped.
 * @param {{
 *   side: HTMLElement,
 *   pull: (path: string) => Promise<any>,
 *   send: (path: string, body: object) => Promise<any>,
 *   face: (name: string, rev: number) => HTMLElement | null,
 *   openAuth: (next: string) => void,
 *   me: () => null | { name: string },
 * }} ctx
 */
function mount(ctx) {
  injectStyles("rl-css", CSS);
  const box = el("div", { class: "rl", "aria-busy": "true" });
  ctx.side.append(box);
  ctx.pull("/api/social/rail").then(
    (data) => {
      if (!box.isConnected) return;
      box.removeAttribute("aria-busy");
      box.replaceChildren(...[people(data.people, ctx), assets(data.assets)].filter(Boolean));
    },
    () => box.remove(),
  );
}

window.__rail = { mount };
