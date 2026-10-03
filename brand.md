# Brand — utopian-go

_Status: active_

## Constraints

### Bandwidth budget

| Metric | Limit | Kind | Why |
|--------|-------|------|-----|
| **gzip** | **&lt; 14,250 B per first-flight response** | **hard** | Each fits one TCP initial congestion window |
| **raw** | soft, per file | soft | Parse/compile weight; warns but does not fail CI |

TCP starts at a 10-segment congestion window (RFC 6928), so ~10 × 1460 B MSS =
**14,600 B** reach the client before anything waits on an ACK. Less ~350 B of response
headers leaves **14,250 B** per response. Under that, a flight lands in one round trip;
over it, cold loads pay another RTT — which on a train or through a VPN hop is the whole
latency budget.

**The budget is per response, not per page.** A document goes out on a cold connection
and gets the whole ten segments. A bundle is only discovered once that document has been
parsed — and therefore ACKed — so it rides either a second connection with its own fresh
window (HTTP/1.1) or one slow start has already grown past ten segments (HTTP/2). Summing
a document with its subresources measures a flight that never happens, so each is checked
alone.

> This replaced an older model that summed every asset into a single 14 KiB flight and
> therefore had to ration the window between them — which is where the "&lt; 8 KiB per
> file" rule came from. The rationing went away when the CSS was inlined and the budget
> model was rewritten (`5522af1`); the 8 KiB number outlived it for a while as a ceiling
> with no physics behind it. Each response's own gzip size against the window is now the
> only per-file guardrail.

There are two documents, each with its own budget and its own bundle:

| Page | Document | Bundle | Lazy |
|------|----------|--------|------|
| Search | `index.html` (13,950 B — the rest is the server-injected price strip) | `app.js` | `swap.js`, `connect.js` |
| Wallet | `wallet.html` | `wallet.js` | `connect.js` |

The wallet page does not share the search shell. It has no search field, tabs, results
list, knowledge panel or skeletons — most of `app.css` — so serving it that stylesheet to
use a tenth of it would cost more than the whole page weighs.

One thing the budget does *not* buy:

- **Raw size is not transfer size.** It governs parse/cache weight only. `app.js` is
  ~22 KiB raw but ~7.5 KiB on the wire.

Assets are precompressed at build time (brotli quality 11) and served as-is, so real
transfer is ~10% below the gzip figure. The budget gates on gzip as the worst case a
client might negotiate.

- Measure with `npm run size` (see `scripts/build-client.mjs`)
- Images (favicon, wordmark) are **outside** these budgets
- Source is readable under `client/`; only `public/` is shipped minified

### Other

- **No web fonts** — system UI stack only
- Source lives in `client/`; built minified assets in `public/`

## Staying under budget

1. **Write readable source** — modules under `client/js/`; never hand-minify
2. **Let the pipeline minify** — esbuild (JS), lightningcss (CSS), html-minifier-terser (HTML)
3. **Prefer shared helpers** over copy-pasted DOM builders (`el`, `cite`, `resultCard`)
4. **Avoid decorative CSS** (long keyframes, multi-stop gradients) unless product-critical
5. **Run `npm run size` after every UI change** — hard fail if any first-flight response exceeds one init window
6. **Server must compress** — `compression` middleware is required for the budget to match production

## Direction

Apple-inspired stark minimal search UI.

- **Palette:** System light/dark via `prefers-color-scheme`
  - Light bg `#f5f5f7`, text `#1d1d1f`, accent `#0071e3` (implementation uses Google-like neutrals + blue)
  - Dark bg `#000` / elevated surfaces, accent `#0a84ff`
- **Typography:** System stack only, weight 400–600
- **Surfaces:** Soft cards, pill search field, whitespace
- **Motion:** Ease-out entrances, staggered result hydrate, skeleton shimmer
- **Voice:** "Search the web. Instantly."

## Do

- Keep every first-flight response under one init window (hard); `npm run size` after UI changes
- Write readable modules under `client/js/`; never hand-minify source
- One accent on grayscale
- Respect `prefers-reduced-motion` when adding animation

## Don't

- Web fonts, icon fonts, large images in the critical shell
- Hand-minified source, or checking in pre-mangled `client/` files
- Gradients-as-decoration, multi-color accents
- Shipping without compression in production
- Shipping without proper cache-control in production
