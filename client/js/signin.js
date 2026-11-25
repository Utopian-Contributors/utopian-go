/**
 * The ways into an account, shared by the Log in dialog (login.js) and the
 * login page (client/auth): log in, create an account, recover one, or a
 * passkey on its own.
 *
 * Each resolves to the server's answer. For an account with no passkey yet
 * that carries `passkeySetup`, the challenge it adds one with, and the caller
 * goes straight on to that step: every account must have a passkey before it
 * can do anything (src/social/guard.ts).
 */
import { NAME_RULE, handleOf } from "./handle.js";
import { writeName } from "./me.js";
import { b64u, needPasskey, u8 } from "./passkey.js";

/** POST JSON to the Social API; throws its error. A name in the answer is remembered. */
export async function send(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  if (data.name) writeName(data.name);
  return data;
}

/**
 * Sign in with a passkey. With a username the password came first and `opt.id`
 * names the one key that may answer; without, the authenticator names the
 * account itself.
 */
async function passkey(opt, username) {
  needPasskey();
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: u8(opt.challenge),
      rpId: location.hostname,
      allowCredentials: opt.id ? [{ type: "public-key", id: u8(opt.id) }] : undefined,
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
  await send("/api/social/login/passkey", {
    ...(username ? { username } : { id: cred.id }),
    challenge: opt.challenge,
    clientData: b64u(response.clientDataJSON),
    authenticatorData: b64u(response.authenticatorData),
    signature: b64u(response.signature),
  });
}

/** A passkey alone: the one on this device picks the account. */
export async function passkeyLogIn() {
  await passkey(await send("/api/social/passkey/login"));
}

/**
 * The form's way in. An account that has a passkey is asked for it once the
 * password checks out, and resolves to null; one without resolves to the
 * server's answer, `passkeySetup` and all.
 *
 * @param {"login" | "register" | "recover"} mode
 * @param {{username?: string, password: string, again?: string, phrase?: string, terms?: boolean}} form
 * @returns {Promise<{name: string, passkeySetup: {challenge: string, uid: string} | null} | null>}
 */
export async function submit(mode, form) {
  if (mode === "recover") {
    // The words the server reads back (src/social/keys.ts): twelve, whatever spacing they were pasted with.
    if (String(form.phrase).trim().split(/\s+/).length !== 12) throw new Error("A recovery phrase is 12 words.");
    return send("/api/social/recover", { phrase: form.phrase, password: form.password });
  }
  // A new name is held to the server's rule here, so the form says so before
  // a round trip does; "@Ada" goes as "ada". A login sends what was typed.
  const name = mode === "register" ? handleOf(form.username) : form.username;
  if (!name) throw new Error(NAME_RULE);
  if (mode === "register" && form.again !== form.password) throw new Error("The passwords don't match.");
  const data = await send(mode === "register" ? "/api/social/register" : "/api/social/login", {
    username: name,
    password: form.password,
    ...(mode === "register" && { terms: form.terms }),
  });
  if (!data.passkey) return data;
  await passkey(data.passkey, String(name).trim().toLowerCase());
  return null;
}
