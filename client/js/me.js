/**
 * The signed-in Social name, remembered by the browser so the header can show
 * it without asking the server on every search. Social and the wallet page
 * keep it true; the cookie is still what the server believes.
 */
const KEY = "ug.me";
const EVENT = "ug:me";
const NAME = /^[a-z0-9_]{3,16}$/;

export function readName() {
  try {
    const name = localStorage.getItem(KEY) || "";
    return NAME.test(name) ? name : "";
  } catch {
    return "";
  }
}

export function writeName(name) {
  const next = NAME.test(name || "") ? name : "";
  if (next === readName()) return;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused: the header shows Get Social, which is still correct enough.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onName(fn) {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key == null) fn();
  });
}

/** Who is signed in, asked once per page and shared by every bundle on it. */
export function account() {
  if (!window.__ugme) {
    window.__ugme = fetch("/api/social/me", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        // Only a real answer corrects the header; a failed request says nothing about the session.
        if (data) writeName(data.me?.name);
        return data?.me ?? null;
      })
      .catch(() => null);
  }
  return window.__ugme;
}
