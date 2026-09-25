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
