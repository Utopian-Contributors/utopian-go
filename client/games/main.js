/**
 * Games: the list of games is static markup, and this is all its script does.
 * It keeps the page offline, and with it every game listed (offline.js), and
 * leaves it without a view transition (js/plainswap.js).
 */
import { keepOffline } from "./offline.js";
import { plainSwap } from "../js/plainswap.js";

plainSwap();

keepOffline();
