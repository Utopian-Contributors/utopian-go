/**
 * Styles for the trade form specifically.
 *
 * The dialog shell, the wallet chooser and the note line moved to js/ui.js
 * when the Login button started opening the same dialog. What is left here is
 * everything only a trade has — the two panes, the amount field, the flip
 * arrow, the confirmation summary — so the login bundle does not carry the
 * styling for controls it will never render.
 */
import { injectStyles } from "../js/ui.js";
import CSS from "./form.css";

/** Called once the trade dialog is about to render its form. */
export function injectFormStyles() {
  injectStyles("swx-form-css", CSS);
}
