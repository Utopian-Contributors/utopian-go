/** WebAuthn plumbing shared by Social and the wallet page's recovery phrase. */

export function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64 or base64url to bytes. The two differ only in two letters. */
export function u8(s) {
  return Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/** Throws where there is no WebAuthn, inside the caller's try so the reason is shown. */
export function needPasskey() {
  if (!window.PublicKeyCredential) throw new Error("This browser can't use a passkey.");
}

/** A refused WebAuthn prompt is a DOMException with no useful message. */
export function why(cause) {
  return cause.name === "NotAllowedError" ? "Passkey was cancelled." : cause.message;
}

/**
 * This device's passkey, signing a challenge the server issued, as the fields
 * the server's assertion check reads.
 *
 * @param {{challenge: string, id: string}} opt
 */
export async function assertion(opt) {
  needPasskey();
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: u8(opt.challenge),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: u8(opt.id) }],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
  return {
    challenge: opt.challenge,
    clientData: b64u(response.clientDataJSON),
    authenticatorData: b64u(response.authenticatorData),
    signature: b64u(response.signature),
  };
}

/**
 * Register this device's passkey for the signed-in account. The server asks
 * for the password first: a passkey signs in without one.
 *
 * @param {string} name
 * @param {string} password
 * @param {(path: string, body?: object) => Promise<any>} post
 * @returns {Promise<{me: {passkey: false | {id: string}}}>} the server's answer, with the account as it now is
 */
export async function register(name, password, post) {
  needPasskey();
  const opt = await post("/api/social/passkey/options", { password });
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: u8(opt.challenge),
      rp: { name: "utopian-go", id: location.hostname },
      user: { id: u8(opt.uid), name, displayName: name },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "required",
        requireResidentKey: true,
      },
      timeout: 60_000,
      attestation: "none",
      // No `prf` here. Asking for it at creation made Firefox on macOS offer
      // only a security key, never the Mac's own passkey sheet. Messenger asks
      // for PRF when it signs in with the passkey (chat/main.js).
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  const response = /** @type {AuthenticatorAttestationResponse} */ (cred.response);
  return post("/api/social/passkey", {
    id: cred.id,
    challenge: opt.challenge,
    clientData: b64u(response.clientDataJSON),
    attestation: b64u(response.attestationObject),
  });
}
