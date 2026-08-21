/**
 * The QR code, as its own bundle.
 *
 * Separate from swap.js because the encoder is 2.1 KB gzipped and almost
 * nobody reaches for it: the code exists for the one crossing a web page
 * cannot make on its own — desktop screen to phone camera — and everybody
 * else, on a phone or with an extension already injected, trades without ever
 * drawing one. Folding it in would have charged that 2.1 KB to every visitor
 * who pressed Buy. Held out here it is fetched by the people who ask for it and
 * then cached, and the cost to everyone else is the `load()` call in
 * swap/main.js.
 *
 * Published as a global rather than imported, because js/lazy.js fetches
 * bundles as plain scripts; see there for why the URL carries a content hash.
 */
import { qrSvg } from "./qr.js";

window.__qr = { svg: qrSvg };
