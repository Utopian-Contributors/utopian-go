# Brand — utopian-go

_Status: active_

## Constraints

### Bandwidth budget (per file)

Budgets apply to **each** of `index.html`, `app.css`, and `app.js` individually — not to their sum.

| Metric | Limit (per file) | Kind | Why |
|--------|------------------|------|-----|
| **gzip** | **&lt; 8 KiB** | **hard** | Real transfer size with `compression` on the server |
| **raw** | **&lt; 20 KiB** | soft | Parse/cache weight; warns but does not fail CI |

- Measure with `npm run size` (see `scripts/build-client.mjs`)
- Images (favicon, wordmark) are **outside** this shell budget
- Source is readable under `client/`; only `public/` is shipped minified

The honest bandwidth number is **gzip per asset** (what clients download for that request).
We keep a raw soft cap so a single asset cannot silently bloat.

### Other

- **No web fonts** — system UI stack only
- Source lives in `client/`; built minified assets in `public/`

## Staying under budget

1. **Write readable source** — modules under `client/js/`; never hand-minify
2. **Let the pipeline minify** — esbuild (JS), lightningcss (CSS), html-minifier-terser (HTML)
3. **Prefer shared helpers** over copy-pasted DOM builders (`el`, `cite`, `resultCard`)
4. **Avoid decorative CSS** (long keyframes, multi-stop gradients) unless product-critical
5. **Run `npm run size` after every UI change** — hard fail only if any file exceeds gzip budget
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

- Keep gzip shell under 8 KiB (hard) and raw under 20 KiB (soft); `npm run size` after UI changes
- Write readable modules under `client/js/`; never hand-minify source
- One accent on grayscale
- Respect `prefers-reduced-motion` when adding animation

## Don't

- Web fonts, icon fonts, large images in the critical shell
- Hand-minified source, or checking in pre-mangled `client/` files
- Gradients-as-decoration, multi-color accents
- Shipping without compression in production
