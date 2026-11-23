/**
 * The Shop — lazy-loaded by social.js on /social/shop, exposed as `window.__shop`.
 *
 * What can be worn after a name (src/social/shop.ts): checkmark badges in
 * every colour, a badge of one's own picture, and fruit statuses, each sold as
 * a pack. A pack owned is a row of choices: pressing one wears it, pressing
 * it again takes it off. One badge and one status at a time. A pack not owned
 * shows what is in it and a Buy button, which checks out by Solana Pay
 * (client/js/solpay.js) as an ad does. Any pack can be given: Gift asks who
 * for, and checks out the same way, for them. A Shop admin (SHOP_ADMINS on the
 * server) has Unlock beside Buy, and in Gift, which owns the pack at once.
 *
 * A prize (won at Fruit Slots, src/social/slots.ts, or given by whoever held
 * it) shows on its pack: Unlock free makes the pack yours, Give passes the
 * prize on, for them to unlock here.
 *
 * Statuses are also had one at a time (`items`, 'st:<fruit>'): bought with
 * Fruit Slots credits, or given. And each game with a board has a set of
 * badges no one can buy (GAME_BADGES): a place in its top ten, at the end of
 * a game, unlocks that place's badge and every commoner one, for good.
 */
import { BADGES, BADGE_PX, GAME_BADGES, PACKS, STATUSES, TIERS, badgeSrc } from "../../src/social/shop.ts";
import { el } from "../js/dom.js";
import { payDialog, usd } from "../js/solpay.js";
import { dialog, injectStyles } from "../js/ui.js";
import { injectFormStyles } from "../swap/ui.js";

const CSS =
  ".sh{display:grid;gap:14px}" +
  ".sh-me{display:flex;align-items:center;gap:10px;padding:12px 15px;border-radius:16px;background:var(--wash);font:600 16px/1.3 var(--ff)}" +
  ".sh-me small{display:block;font-weight:400;font-size:12px;color:var(--f)}" +
  ".sh-p{padding:14px;border:1px solid var(--ln);border-radius:16px}" +
  ".sh-p h3{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0;font:600 15px/1.3 var(--ff)}" +
  ".sh-p h3 span{font-weight:400;font-size:13px;color:var(--f)}" +
  ".sh-g{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin:12px 0 0}" +
  ".sh-t{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border:2px solid transparent;border-radius:14px;background:var(--wash);color:var(--t);font:500 12px/1.25 var(--ff);text-align:center;cursor:pointer}" +
  ".sh-t img{width:32px;height:32px}" +
  ".sh-t.on{border-color:var(--a)}" +
  ".sh-t:disabled{cursor:default;opacity:.6}" +
  ".sh-t:not(:disabled):hover{filter:brightness(1.05)}" +
  // A won badge's card: the place that unlocks it, large in the top right, faded into the card.
  ".sh-w{position:relative;overflow:hidden;isolation:isolate}" +
  ".sh-rk{position:absolute;top:2px;right:7px;z-index:-1;font:800 28px/1 var(--ff);letter-spacing:-.04em;color:var(--t);opacity:.13;pointer-events:none}" +
  ".sh-b{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}" +
  ".sh-b .go-pill{margin:0}" +
  ".sh-b .hint{margin:0}" +
  ".sh-b .sh-2,.swx-go.sh-2{background:var(--wash);color:var(--t)}" +
  ".sh-f{display:grid;gap:10px}" +
  ".sh-f label{font-size:13px;color:var(--f)}" +
  ".sh-in{width:100%;padding:10px 12px;border:1px solid var(--ln);border-radius:12px;background:var(--wash);color:var(--t);font:16px/1.3 var(--ff)}" +
  ".sh-f .swx-go{width:100%}" +
  // The bar's Back only where the tabs leave no way back; on a desk it keeps
  // its room, so the title stays centred.
  ".sh>.detail-bar{margin:0}" +
  "@media (min-width:901px){.sh>.detail-bar .back{visibility:hidden}}" +
  "@media (max-width:900px){.sh{padding-top:12px}}" +
  ".sh>.err{margin:0}.sh>.err:empty{display:none}";

const cap = (word) => word[0].toUpperCase() + word.slice(1);

/**
 * A square picture, `BADGE_PX` across, drawn whole and centred on a clear
 * ground, as a PNG: the server takes nothing else (isBadgePng).
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function badgePng(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = BADGE_PX;
  const scale = BADGE_PX / Math.max(bitmap.width, bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  canvas.getContext("2d").drawImage(bitmap, (BADGE_PX - w) / 2, (BADGE_PX - h) / 2, w, h);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not read that picture.");
  return blob;
}

/**
 * @param {{
 *   main: HTMLElement,
 *   me: () => null | { name: string, avatarRev: number },
 *   pull: (path: string, opts?: object) => Promise<any>,
 *   send: (path: string, body?: object) => Promise<any>,
 *   face: (name: string, rev: number) => HTMLElement | null,
 *   marks: (name: string, mark?: string) => (HTMLElement | null)[],
 *   show: () => void,
 * }} kit
 */
async function mount({ main, me, pull, send, face, marks, show }) {
  injectStyles("sh-css", CSS);
  const state = await pull("/api/social/shop");
  const name = me()?.name || "";
  const err = el("p", { class: "err", role: "alert" });
  let busy = false;

  /** Wear one thing, or take it off, and draw the page again. */
  async function put(field, value) {
    if (busy) return;
    busy = true;
    err.textContent = "";
    try {
      const worn = await send("/api/social/shop/wear", { [field]: state[field] === value || (value === "u" && state.badge[0] === "u") ? "" : value });
      state.badge = worn.badge;
      state.status = worn.status;
      paint();
    } catch (cause) {
      err.textContent = cause.message;
    } finally {
      busy = false;
    }
  }

  /** The Solana Pay code for an order, yours or a gift (`order.for`). */
  function checkout(pack, order) {
    const gift = order.for !== name;
    payDialog(order, {
      pull,
      check: `/api/social/shop/order/${order.id}`,
      fine: `Pay exactly this amount: its last digits tell this payment apart, even when a wallet leaves out the memo. Once it is paid, the pack is ${gift ? `${order.for}’s` : "yours"} for good.`,
      done: gift
        ? { title: "Gift sent", text: `${PACKS[pack].title} are ${order.for}’s to wear now.` }
        : { title: "It’s yours", text: `${PACKS[pack].title}: pick what to wear in the Shop.` },
      finish: show,
    });
  }

  /** Press a button that asks the server something; its error shows in `out`. */
  async function press(button, out, run) {
    out.textContent = "";
    button.disabled = true;
    try {
      await run();
    } catch (cause) {
      out.textContent = cause.message;
    } finally {
      button.disabled = false;
    }
  }

  /** Who a pack is for, then Pay (a gift by Solana Pay) or, for an admin, Unlock. */
  function giftDialog(pack) {
    injectFormStyles();
    const { body, close } = dialog(`Gift ${PACKS[pack].title}`);
    const input = el("input", {
      id: "sh-to",
      class: "sh-in",
      maxlength: "16",
      placeholder: "username",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
    });
    const out = el("p", { class: "err", role: "alert" });
    const who = () => input.value.trim().toLowerCase().replace(/^@/, "");
    const pay = el("button", { type: "submit", class: "swx-go", text: `Pay ${usd(state.packs[pack].cents)}` });
    if (!state.payable) pay.disabled = true;
    const unlock = state.admin
      ? el("button", {
          type: "button",
          class: "swx-go sh-2",
          text: "Unlock for them",
          onclick: () =>
            press(unlock, out, async () => {
              await send("/api/social/shop/grant", { pack, for: who() });
              close();
              show();
            }),
        })
      : null;
    const form = el(
      "form",
      { class: "sh-f" },
      el("label", { for: "sh-to", text: "Who is it for?" }),
      input,
      pay,
      unlock,
      state.payable ? null : el("p", { class: "hint", text: "Payments are not set up on this server yet." }),
      out,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      press(pay, out, async () => {
        const { order } = await send("/api/social/shop/buy", { pack, for: who() });
        close();
        checkout(pack, order);
      });
    });
    body.replaceChildren(form);
    input.focus();
  }

  async function upload(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    err.textContent = "";
    try {
      const data = await pull("/api/social/shop/badge", { method: "POST", body: await badgePng(file) });
      state.badgeRev = data.badgeRev;
      if (state.badge[0] === "u") state.badge = `u${data.badgeRev}`;
      paint();
    } catch (cause) {
      err.textContent = cause.message;
    }
  }

  function tile(img, label, on, owned, press) {
    return el(
      "button",
      { type: "button", class: on ? "sh-t on" : "sh-t", "aria-pressed": String(on), disabled: !owned, onclick: press },
      el("img", { src: img, alt: "", width: "32", height: "32" }),
      label,
    );
  }

  /** Give a prize on: who to, then it is theirs to unlock here. */
  function givePrizeDialog(prize) {
    injectFormStyles();
    const { body, close } = dialog(`Give ${PACKS[prize.pack].title}`);
    const input = el("input", {
      id: "sh-pz",
      class: "sh-in",
      maxlength: "17",
      placeholder: "username",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
    });
    const out = el("p", { class: "err", role: "alert" });
    const go = el("button", { type: "submit", class: "swx-go", text: "Give for free" });
    const form = el("form", { class: "sh-f" }, el("label", { for: "sh-pz", text: "Who is it for? They unlock it here, free." }), input, go, out);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      press(go, out, async () => {
        await send(`/api/social/shop/prize/${prize.id}/give`, { to: input.value.trim() });
        close();
        show();
      });
    });
    body.replaceChildren(form);
    input.focus();
  }

  /** The prizes held for a pack: Unlock free (while it is not owned) and Give. */
  function prizeRows(id, owned) {
    return (state.prizes || [])
      .filter((prize) => prize.pack === id)
      .map((prize) => {
        const fruit = prize.item ? prize.item.slice(3) : "";
        const had = prize.item ? owned || (state.items || []).includes(prize.item) : owned;
        const unlock = el("button", {
          type: "button",
          class: "go-pill",
          text: "Unlock free",
          onclick: () =>
            press(unlock, err, async () => {
              await send(`/api/social/shop/prize/${prize.id}/unlock`, {});
              show();
            }),
        });
        const give = el("button", { type: "button", class: "go-pill sh-2", text: "Give", onclick: () => givePrizeDialog(prize) });
        const what = fruit ? `${STATUSES[fruit]}: ` : "";
        return el(
          "div",
          { class: "sh-b" },
          fruit ? el("img", { src: `/st-${fruit}.svg`, alt: "", width: "24", height: "24" }) : null,
          had ? null : unlock,
          give,
          el("p", { class: "hint", text: `${what}${prize.givenBy ? `a gift from @${prize.givenBy}` : "won at Fruit Slots"}` }),
        );
      });
  }

  /** A pack: its title and price, its choices, Buy (or an admin's Unlock) while it is not owned, and Gift. */
  function pack(id, tiles, extra) {
    const owned = state.owned.includes(id);
    const go = el("button", {
      type: "button",
      class: "go-pill",
      text: `Buy · ${usd(state.packs[id].cents)}`,
      onclick: () => press(go, err, async () => checkout(id, (await send("/api/social/shop/buy", { pack: id })).order)),
    });
    if (!state.payable) go.disabled = true;
    const unlock = el("button", {
      type: "button",
      class: "go-pill sh-2",
      text: "Unlock",
      onclick: () =>
        press(unlock, err, async () => {
          await send("/api/social/shop/grant", { pack: id });
          show();
        }),
    });
    const gift = el("button", { type: "button", class: "go-pill sh-2", text: "Gift", onclick: () => giftDialog(id) });
    return el(
      "section",
      { class: "sh-p" },
      el("h3", {}, state.packs[id].title, el("span", { text: owned ? "Yours" : usd(state.packs[id].cents) })),
      el("div", { class: "sh-g" }, ...tiles(owned)),
      owned ? extra : null,
      ...prizeRows(id, owned),
      el(
        "div",
        { class: "sh-b" },
        owned ? null : go,
        owned || !state.admin ? null : unlock,
        gift,
        owned || state.payable ? null : el("p", { class: "hint", text: "Payments are not set up on this server yet." }),
      ),
    );
  }

  /** A game's won badges: each worn once unlocked, else the place that unlocks it. */
  function won(game, title, href) {
    // The lowest place that unlocks it: #6 for #4–6, #10 for #7–10.
    const place = (t) => `#${t.to}`;
    const items = new Set(state.items || []);
    return el(
      "section",
      { class: "sh-p" },
      el("h3", {}, title, el("span", { text: "Top ten only" })),
      el(
        "div",
        { class: "sh-g" },
        ...GAME_BADGES[game].map((badge, i) => {
          const have = items.has(`bd:${badge.id}`);
          const spot = place(TIERS[i]);
          const card = tile(`/bd-${badge.id}.svg`, badge.name, state.badge === badge.id, have, () => put("badge", badge.id));
          // The place that unlocks it, large in the corner and faded into the card.
          card.classList.add("sh-w");
          card.prepend(el("span", { class: "sh-rk", "aria-hidden": "true", text: spot }));
          card.setAttribute("aria-label", have ? badge.name : `${badge.name}, unlocked by place ${spot}`);
          return card;
        }),
      ),
      el(
        "div",
        { class: "sh-b" },
        el("a", { class: "go-pill sh-2", href, text: "Play" }),
        el("p", { class: "hint", text: "Finish a synced game in the top ten to unlock that place’s badge and every one after it, for good." }),
      ),
    );
  }

  function paint() {
    const items = new Set(state.items || []);
    const mark = `${state.badge} ${state.status}`;
    const own = state.badgeRev > 0 ? badgeSrc(name, `u${state.badgeRev}`) : "/ic-image.svg";
    const pick = el("input", { type: "file", accept: "image/*", hidden: true, onchange: (e) => upload(e.target) });
    const who = me();
    main.replaceChildren(
      el(
        "div",
        { class: "sh" },
        // Edit profile's bar: on a phone, where the tabs carry no Shop, that page is the way in.
        el(
          "div",
          { class: "detail-bar" },
          el("a", { class: "back", href: "/social/edit", text: "Back" }),
          el("h2", { class: "ed-h", text: "Shop" }),
        ),
        el(
          "div",
          { class: "sh-me" },
          who ? face(who.name, who.avatarRev) : null,
          el(
            "div",
            {},
            el("div", {}, name, ...marks(name, mark === " " ? "" : mark)),
            el("small", { text: "One badge and one status at a time, after your name everywhere." }),
          ),
        ),
        pack("checks", (owned) => BADGES.map((c) => tile(`/bd-${c}.svg`, cap(c), state.badge === c, owned, () => put("badge", c)))),
        pack(
          "custom",
          (owned) => [tile(own, "Your own", state.badge[0] === "u", owned && state.badgeRev > 0, () => put("badge", "u"))],
          el(
            "div",
            { class: "sh-b" },
            el("label", { class: "go-pill" }, state.badgeRev ? "Replace picture" : "Upload picture", pick),
            el("p", { class: "hint", text: "A square works best; it is shown 16px tall." }),
          ),
        ),
        pack("fruit", (owned) =>
          Object.entries(STATUSES).map(([id, words]) =>
            tile(`/st-${id}.svg`, words, state.status === id, owned || items.has(`st:${id}`), () => put("status", id)),
          ),
        ),
        won("snake", "Snake badges", "/snake"),
        won("pinball", "Pinball badges", "/pinball"),
        err,
      ),
    );
  }

  paint();
}

window.__shop = { mount };
