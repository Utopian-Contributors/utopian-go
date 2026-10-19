/**
 * Notifications: comments on your posts and re-posts of them.
 *
 * Its own bundle, fetched by social.js on /social/notifications only, beside
 * the notes it shows. Handed social.js's helpers so it carries no copies.
 */
import { el } from "../js/dom.js";

/**
 * The ones you have not seen under New, the rest under Earlier, newest first.
 * Each opens its post.
 * @param {{ notes: object[] }} data
 * @param {{
 *   main: HTMLElement, send: (path: string, body?: object) => Promise<any>,
 *   face: (name: string, rev: number) => HTMLElement | null, useSide: (on: boolean) => void,
 * }} kit
 */
function mount(data, { main, send, face, useSide }) {
  useSide(false);
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const group = (title, notes) =>
    notes.length
      ? el(
          "section",
          { class: "abc", "aria-label": title },
          el("h3", { class: "abc-h", text: title }),
          ...notes.map((note) =>
            el(
              "a",
              { class: "friend nt", href: `/social/p/${note.post}` },
              face(note.from, note.avatarRev),
              el(
                "div",
                { class: "friend-main" },
                el("b", { text: note.from }),
                note.kind === "repost" ? " re-posted your post" : " commented on your post",
                el("time", { datetime: new Date(note.at).toISOString(), text: when.format(note.at) }),
              ),
            ),
          ),
        )
      : null;
  const fresh = data.notes.filter((note) => !note.seen);
  main.replaceChildren(
    data.notes.length
      ? el("div", { class: "friends" }, group("New", fresh), group("Earlier", data.notes.filter((note) => note.seen)))
      : el("p", { class: "muted", text: "No notifications yet." }),
  );
  if (fresh.length) {
    // The answer's `me` has nothing unseen, which takes the badge down.
    send("/api/social/notes/seen").catch(() => {});
  }
}

window.__notes = { mount };
