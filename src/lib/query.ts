/**
 * Read one caller-supplied value as a string, whatever they actually sent.
 *
 * Nothing about a request is a string because we asked for one. Express parses
 * query strings with `qs` in extended mode — and with `allowPrototypes: true`,
 * which is what makes this reachable — so `?q=a` is a string, `?q=a&q=b` is an
 * array, and `?q[x]=1` is an object, all from one parameter name, all chosen by
 * the caller. A JSON body is the same: any field can arrive as any shape.
 *
 * `String(value)` looks like it copes and does not. On an object whose own
 * `toString` is a string rather than a function, coercion throws:
 *
 *     GET  /api/search?q[toString]=1
 *     POST /api/balances {"owner":{"toString":1}}
 *          ->  TypeError: Cannot convert object to primitive value
 *
 * Thrown inside an async handler that is a rejected promise Express 4 does not
 * catch — which killed the process outright, and now merely hangs the request
 * forever. Coercion happens here and nowhere else, and here it cannot throw:
 *
 *  - a string is itself
 *  - an array takes its first string entry, which is what a repeated parameter
 *    means to anyone typing one
 *  - anything else — object, number, null, undefined — is no value at all
 */
export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}
