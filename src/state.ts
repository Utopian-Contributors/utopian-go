/**
 * State tags: a hash of what a response says, so a client holding a snapshot
 * can ask "has this changed?" and be answered with a 304 and no body.
 *
 * The offline app (client/offline, client/sw) keeps the pages and API answers
 * it last saw. When the connection comes back it does not refetch them to
 * find out whether anything moved: it sends each snapshot's tag as
 * If-None-Match, marked X-UG-Check, and offers Update only for a 200.
 *
 * A tag is `"<state>"`, or `"<state>.<extra>"` when the response carries
 * something that is not state: an ad. (A countdown is not state either, and
 * is left out entirely; see stateOfBody.) Ads rotate between requests and are
 * charged as they are put in, so they are left out of the state hash, and a
 * check compares the state part only. An exact match is still what the
 * browser's own revalidation needs, and still gets, so a different ad is a
 * different response there exactly as before.
 *
 * Two things about checks:
 *  - They never carry an ad (see isCheck): nothing they fetch is shown, and an
 *    impression nobody sees must not be charged.
 *  - They arrive with Cache-Control: no-cache, which a browser adds to any
 *    request whose author set a conditional header. Taken literally that
 *    makes every copy stale; for a check it is only how the request got past
 *    the browser's cache, so it is dropped and the tag is honoured.
 */
import { createHash } from "crypto";
import type { NextFunction, Request, Response } from "express";

const hash = (text: string) => createHash("sha1").update(text).digest("base64url").slice(0, 22);

/**
 * A JSON answer as state: without its ad, and without `me.wait`, the time
 * left before the account may post again. That is a countdown worked out
 * against the clock on every request, not data, and the page counts it down
 * itself; hashed, it would make every answer that carries `me` look changed.
 */
function stateOfBody(body: Record<string, unknown>): { state: string; ad: unknown } {
  const { ad, ...rest } = body;
  const me = rest.me;
  if (me && typeof me === "object" && "wait" in me) {
    const { wait: _wait, ...still } = me as Record<string, unknown>;
    rest.me = still;
  }
  return { state: JSON.stringify(rest), ad };
}

/** A check from the offline app: compare, never charge, never send an ad. */
export function isCheck(req: Request): boolean {
  return req.get("x-ug-check") === "1";
}

/** A tag for this state, and for whatever rides along that is not state. */
export function stateTag(state: string, extra?: string): string {
  return `"${hash(state)}${extra ? `.${hash(extra).slice(0, 8)}` : ""}"`;
}

/** The state half of a tag as a client sent it back: no W/, no quotes, no extra. */
function stateOf(tag: string): string {
  return tag.trim().replace(/^W\//, "").replace(/"/g, "").split(".")[0];
}

/** Whether the client already holds this state, whatever ad rode along with it. */
export function sameState(req: Request, tag: string): boolean {
  const sent = req.get("if-none-match");
  if (!sent) return false;
  const mine = stateOf(tag);
  return sent.split(",").some((one) => stateOf(one) === mine);
}

/**
 * Answer 304 if the client holds this state. For a route that must decide
 * before it does something expensive or chargeable, like picking an ad.
 */
export function unchanged(req: Request, res: Response, state: Record<string, unknown>): boolean {
  const tag = stateTag(stateOfBody(state).state);
  if (!sameState(req, tag)) return false;
  res.setHeader("ETag", tag);
  res.status(304).end();
  return true;
}

/**
 * Every GET: a check's no-cache is dropped, and every JSON answer is tagged
 * by its state, the ad left out, and answered 304 when the client holds it.
 */
export function stateTags(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET") return next();
  if (isCheck(req)) {
    delete req.headers["cache-control"];
    delete req.headers.pragma;
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return json(body);
    const { state, ad } = stateOfBody(body as Record<string, unknown>);
    const tag = stateTag(state, ad ? JSON.stringify(ad) : undefined);
    res.setHeader("ETag", tag);
    if (sameState(req, tag)) {
      res.status(304).end();
      return res;
    }
    return json(body);
  };
  next();
}
