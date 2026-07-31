# Brand — utopian-go

_Status: active_

## Constraints

### Bandwidth budget

| Metric | Limit | Kind | Why |
|--------|-------|------|-----|
| **total gzip** | **&lt; 14 KiB** | **hard** | The whole shell fits one TCP initial congestion window |
| **gzip** | &lt; 8 KiB per file | hard | No single asset dominates the shell |
| **raw** | &lt; 20 KiB per file | soft | Parse/cache weight; warns but does not fail CI |

The budget that physically matters is **total compressed**. TCP starts at a 10-segment
congestion window (RFC 6928), so ~10 × 1460 B MSS = **14,600 B** reach the client before
anything waits on an ACK. Under that, a flight lands in one round trip; over it, cold
loads pay another RTT — which on a train or through a VPN hop is the whole latency budget.

Two things that budget does *not* buy:

- **Raw size is not transfer size.** It governs parse/cache weight only. `app.js` is
  ~18 KiB raw but ~6.8 KiB on the wire.
- **The shell is still 2 RTTs**, because the browser must parse `index.html` before it
  discovers `/app.css` and `/app.js`. Shrinking files cannot fix that; only inlining the
  critical CSS/JS into the HTML would.

`compression@1.8.1` negotiates **brotli** as well as gzip, so real transfer is ~12% below
the gzip figure. The budget gates on gzip as the worst case a client might negotiate.

- Measure with `npm run size` (see `scripts/build-client.mjs`)
- Images (favicon, wordmark) are **outside** this shell budget
- Source is readable under `client/`; only `public/` is shipped minified

### Other

- **No web fonts** — system UI stack only
- Source lives in `client/`; built minified assets in `public/`

## Staying under budget

1. **Write readable source** — modules under `client/js/`; never hand-minify
2. **Let the pipeline minify** — esbuild (JS), lightningcss (CSS), html-minifier-terser (HTML)
3. **Prefer shared helpers** over copy-pasted DOM builders (`el`, `cite`, `resultCard`)
4. **Avoid decorative CSS** (long keyframes, multi-stop gradients) unless product-critical
5. **Run `npm run size` after every UI change** — hard fail if total gzip exceeds one init window, or any single file exceeds its gzip budget
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

- Keep the total gzip shell under 14 KiB (hard) and each file under 8 KiB gzip; `npm run size` after UI changes
- Write readable modules under `client/js/`; never hand-minify source
- One accent on grayscale
- Respect `prefers-reduced-motion` when adding animation

## Don't

- Web fonts, icon fonts, large images in the critical shell
- Hand-minified source, or checking in pre-mangled `client/` files
- Gradients-as-decoration, multi-color accents
- Shipping without compression in production
- Shipping without proper cache-control in production
