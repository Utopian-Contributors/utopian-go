/**
 * Edit profile: the photo, bio and location, then the passkey and the
 * recovery phrase, each behind the password.
 *
 * Its own bundle, fetched by social.js on /social/edit only, so the timeline
 * carries neither these settings nor the passkey and dialog code under them.
 * Handed social.js's helpers so it carries no copies.
 */
import { el } from "../js/dom.js";
import { register, why } from "../js/passkey.js";
import { dismissible } from "../js/sheet.js";
import { bin, lens, shrink } from "../js/shrink.js";

/** 4…4, as an address or a credential id is shown in a row. */
const short = (s) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** One setting: its name, its value in grey, and a chevron. Pressed, it opens what changes it. */
function settingRow(label, value, onclick) {
  return el(
    "button",
    { type: "button", class: "row", onclick },
    el("span", { text: label }),
    el("span", { class: "row-v", text: value }),
  );
}

/**
 * A password box in front of one action, in a dialog that removes itself,
 * and whatever it showed, when closed. The password is checked by the server.
 */
function passDialog(title, label, run) {
  const input = el("input", { id: "pd-pw", type: "password", autocomplete: "current-password", required: true });
  const err = el("p", { class: "err", role: "alert" });
  const go = el("button", { type: "submit", text: label });
  const form = el("form", { class: "tools" }, el("label", { for: "pd-pw" }, "Password"), input, go, err);
  const dialog = /** @type {HTMLDialogElement} */ (
    el("dialog", { class: "pd", "aria-label": title }, el("h2", { text: title }), form)
  );
  dismissible(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    go.disabled = true;
    try {
      await run(input.value);
      input.value = "";
    } catch (cause) {
      err.textContent = why(cause);
    } finally {
      go.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, form };
}

/** Add this device's passkey, or replace the one on the account. The server asks for the password first. */
function passkeyDialog(me, send, show) {
  const label = me.passkey ? "Replace passkey" : "Add passkey";
  const { dialog } = passDialog("Passkey", label, async (password) => {
    await register(me.name, password, send);
    dialog.close();
    show();
  });
}

/**
 * The recovery phrase, behind the password. The words leave with the dialog:
 * on its X, after two minutes, or as soon as the tab is put away, whichever
 * comes first. A phrase left on an unattended screen is a wallet left open.
 */
function phraseDialog(send) {
  let timer = 0;
  const away = () => document.hidden && dialog.close();
  const { dialog, form } = passDialog("Recovery phrase", "Show phrase", async (password) => {
    const result = await send("/api/social/phrase", { password });
    form.replaceWith(el("p", { class: "phrase", text: result.phrase }));
    timer = window.setTimeout(() => dialog.close(), 120_000);
    document.addEventListener("visibilitychange", away);
  });
  dialog.addEventListener("close", () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", away);
  });
}

/**
 * Only the settings, no card and no posts.
 * @param {{
 *   main: HTMLElement, me: () => any, pull: (path: string, opts?: object) => Promise<any>,
 *   send: (path: string, body?: object) => Promise<any>, show: () => void,
 *   photo: (name: string, rev: number) => HTMLElement | null, load: (attr: string, global: string) => Promise<any>,
 *   useSide: (on: boolean) => void, renderSide: (person: any) => void,
 * }} kit
 */
async function mount({ main, me: who, pull, send, show, photo, load, useSide, renderSide }) {
  if (!who()) await pull("/api/social/me");
  const me = who();
  if (!me) {
    renderSide(null);
    main.replaceChildren(
      el("p", { class: "muted", text: "Log in to edit your profile." }),
    );
    return;
  }
  useSide(false);
  const bioInput = el("textarea", {
    id: "bio",
    maxlength: "160",
    text: me.bio,
  });
  const locInput = el("input", { id: "loc", maxlength: "40", value: me.loc });
  const saveErr = el("p", { class: "err" });
  const save = el(
    "form",
    { class: "tools" },
    el("label", { for: "bio" }, "Bio"),
    bioInput,
    el("p", { class: "hint", text: "Up to 160 characters." }),
    el("label", { for: "loc" }, "Location"),
    locInput,
    el("p", {
      class: "hint",
      text: "Up to 40 characters. Leave blank to clear.",
    }),
    el("button", { type: "submit", text: "Save" }),
    saveErr,
  );
  save.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveErr.textContent = "";
    try {
      // The answer carries the saved `me`, which the redraw fills the fields from.
      await send("/api/social/profile", {
        bio: bioInput.value,
        loc: locInput.value,
      });
      show();
    } catch (cause) {
      saveErr.textContent = cause.message;
    }
  });

  const photoErr = el("p", { class: "err" });
  const file = el("input", { type: "file", accept: "image/*", id: "pic" });
  file.addEventListener("change", async () => {
    const picked = file.files && file.files[0];
    photoErr.textContent = "";
    if (!picked) return;
    try {
      // The profile copy stays within 14KB at the uploaded shape. The
      // timeline copy is at most 80px wide and 2KB: enough to see a face
      // beside a post, not enough to make a feed of them slow.
      const [full, tiny] = await shrink(
        picked,
        [
          [480, 0, 14 * 1024, 0.86],
          [80, 1, 2 * 1024, 0.7],
        ],
        (await load("av", "__avatar")).under(me.name),
      );
      await pull("/api/social/avatar", {
        method: "POST",
        body: bin([lens(tiny, full), tiny, full]),
      });
      show();
    } catch (cause) {
      photoErr.textContent = cause.message;
    }
    file.value = "";
  });

  main.replaceChildren(
    el(
      "div",
      { class: "detail-bar" },
      el("a", { class: "back", href: `/social/u/${me.name}`, text: "Back" }),
      el("h2", { class: "ed-h", text: "Edit profile" }),
    ),
    el(
      "section",
      { class: "sec" },
      el("h3", { text: "General" }),
      el(
        "label",
        { class: "file", for: "pic" },
        photo(me.name, me.avatarRev),
        el("span", { text: me.avatarRev ? "Change photo" : "Add photo" }),
        file,
      ),
      photoErr,
      save,
    ),
    el(
      "section",
      { class: "sec" },
      el("h3", { text: "Security" }),
      el(
        "div",
        { class: "rows" },
        settingRow("Passkey", me.passkey ? short(me.passkey.id) : "Not set up", () => passkeyDialog(me, send, show)),
        settingRow("Wallet", short(me.address), () => phraseDialog(send)),
      ),
    ),
  );
}

window.__edit = { mount };
