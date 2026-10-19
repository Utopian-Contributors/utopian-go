/**
 * Friends: find a person by name and add them, and the people already added,
 * A to Z.
 *
 * Its own bundle, fetched by social.js on /social/friends only, beside the
 * list it shows. Handed social.js's helpers so it carries no copies.
 */
import { el } from "../js/dom.js";

/**
 * Search, then the people already added. No profile card on this page.
 * @param {{ friends: object[] }} data
 * @param {{
 *   main: HTMLElement, me: () => null | { name: string },
 *   pull: (path: string, opts?: object) => Promise<any>, send: (path: string, body?: object) => Promise<any>,
 *   thumb: (name: string, rev: number) => HTMLElement | null, face: (name: string, rev: number) => HTMLElement | null,
 *   useSide: (on: boolean) => void,
 * }} kit
 */
function mount(data, { main, me: who, pull, send, thumb, face, useSide }) {
  const me = who();
  useSide(false);
  const input = el("input", {
    type: "search",
    maxlength: "16",
    placeholder: "Find a person",
    "aria-label": "Find a person",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "people",
    autocapitalize: "off",
    autocomplete: "off",
    spellcheck: "false",
  });
  const hits = el("ul", { id: "people", class: "hits", role: "listbox", hidden: true });
  const err = el("p", { class: "err" });
  const list = el("div", { class: "friends" });
  let wait = 0;
  let gen = 0;
  let busy = false;
  let shown = "";

  function row(friend) {
    return el(
      "article",
      { class: "friend" },
      thumb(friend.name, friend.avatarRev),
      el(
        "div",
        { class: "friend-main" },
        el("a", {
          class: "who",
          href: `/social/u/${friend.name}`,
          text: friend.name,
        }),
        friend.loc ? el("div", { class: "muted", text: friend.loc }) : null,
        friend.bio ? el("div", { text: friend.bio }) : null,
      ),
      el("button", {
        type: "button",
        class: "ghost",
        text: "Remove",
        onclick: () => remove(friend.name),
      }),
    );
  }

  /** A to Z like a contact book, one heading per letter. Digits and _ go last, under #. */
  function paint(friends) {
    if (!friends.length)
      return list.replaceChildren(
        el("p", { class: "muted", text: "No friends yet." }),
      );
    const letter = (name) =>
      /^[a-z]/.test(name) ? name[0].toUpperCase() : "#";
    const sorted = [...friends].sort((a, b) => {
      const la = letter(a.name);
      const lb = letter(b.name);
      if (la !== lb) return la === "#" ? 1 : lb === "#" ? -1 : la < lb ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const groups = [];
    for (const friend of sorted) {
      const key = letter(friend.name);
      if (groups.at(-1)?.key !== key) groups.push({ key, rows: [] });
      groups.at(-1).rows.push(row(friend));
    }
    list.replaceChildren(
      ...groups.map((group) =>
        el(
          "section",
          { class: "abc", "aria-label": group.key },
          el("h3", { class: "abc-h", text: group.key }),
          ...group.rows,
        ),
      ),
    );
  }

  function remove(name) {
    pull(`/api/social/friends/${name}`, { method: "DELETE" })
      .then((fresh) => {
        err.textContent = "";
        paint(fresh.friends);
      })
      .catch((cause) => {
        err.textContent = cause.message;
      });
  }

  function shut() {
    shown = "";
    hits.replaceChildren();
    hits.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function fill(nodes, q) {
    shown = q;
    hits.replaceChildren(...nodes);
    hits.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function look() {
    const q = input.value.trim().toLowerCase();
    const mine = ++gen;
    err.textContent = "";
    if (!q) return shut();
    if (me && q === me.name) return fill([el("li", { class: "empty", text: "You can't add yourself." })], q);
    if (!/^[a-z0-9_]{1,16}$/.test(q)) return shut();
    pull(`/api/social/users?q=${q}`)
      .then((found) => {
        if (mine !== gen || input.value.trim().toLowerCase() !== q) return;
        const users = found.users;
        if (!users.length) return fill([el("li", { class: "empty", text: "No one by that name." })], q);
        fill(
          users.map((user) => {
            const row = el(
              "button",
              { type: "button", class: "hit", disabled: user.friend },
              face(user.name, user.avatarRev),
              el("span", { class: "who", text: user.name }),
              user.loc ? el("span", { class: "muted", text: user.loc }) : null,
              el("span", { class: "tag", text: user.friend ? "Friends" : "Add" }),
            );
            if (!user.friend) row.addEventListener("click", () => add(user.name));
            return el("li", {}, row);
          }),
          q,
        );
      })
      .catch((cause) => {
        if (mine !== gen) return;
        err.textContent = cause.message;
        shut();
      });
  }

  function add(name) {
    if (busy) return;
    busy = true;
    err.textContent = "";
    gen += 1;
    send("/api/social/friends", { username: name })
      .then((fresh) => {
        input.value = "";
        shut();
        paint(fresh.friends);
        input.focus();
      })
      .catch((cause) => {
        err.textContent = cause.message;
      })
      .finally(() => {
        busy = false;
      });
  }

  function picks() {
    if (shown !== input.value.trim().toLowerCase()) return [];
    return [...hits.querySelectorAll("button.hit:not(:disabled)")];
  }

  input.addEventListener("input", () => {
    clearTimeout(wait);
    wait = setTimeout(look, 150);
  });
  input.addEventListener("keydown", (e) => {
    const rows = picks();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const on = rows.findIndex((row) => row.classList.contains("on"));
      const step = e.key === "ArrowDown" ? 1 : -1;
      let next = on + step;
      if (next < 0) next = rows.length - 1;
      if (next >= rows.length) next = 0;
      for (const row of rows) row.classList.remove("on");
      rows[next].classList.add("on");
      return;
    }
    if (e.key === "Escape") return shut();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = input.value.trim().toLowerCase();
    if (me && q === me.name) return;
    const pick = rows.find((row) => row.classList.contains("on")) || (rows.length === 1 ? rows[0] : null);
    if (pick) pick.click();
    else if (/^[a-z0-9_]{3,16}$/.test(q)) add(q);
  });
  hits.addEventListener("mousedown", (e) => e.preventDefault());
  paint(data.friends);
  main.replaceChildren(el("div", { class: "find" }, input, hits), err, list);
  input.focus();
}

window.__friends = { mount };
