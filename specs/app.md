# UtopianGO — the app

**Status:** Draft
**Author:** Ludwig Schubert
**Created:** 2026-09-25
**Updated:** 2026-09-25

## Summary

UtopianGO is one small web app for three things people do online: search the web, post to
a timeline, and chat. It ships at UtopianGo.com as a few static documents over a thin
Express server, with a Solana wallet built in so people can pay each other and trade.
Every page is built to load in one round trip on a bad connection and to look like the
browser it runs in.

## Motivation

Most people who could use this are on a cheap phone, a metered plan, a train, or a VPN
hop. A superapp usually means a large client, an account wall, and a design system of its
own. Each of those shuts someone out.

The intention behind the product:

- **As little data and UI as can be built.** Fewer bytes reach more people. Fewer controls
  are learned faster. A feature that cannot be made small does not ship.
- **Profile pictures keep their own shape.** A face is not cropped into a circle. Each
  picture keeps the outline its owner gave it, so the timeline reads as individual people,
  not identical tokens.

The engineering follows from that:

- **The most maintainable and efficient implementation wins,** even when it is the less
  clever one.
- **Little to no syntactic sugar.** No explanation comments, and no long or unnecessary
  logs in scripts.
- **Do more with less.** Use browser-native fonts, styles and controls, and add only as much
  branding as it takes for the app to feel familiar and usable.

## Design

### Architecture

```mermaid
graph LR
    subgraph Browser
        S[index.html + app.js<br/>Search]
        W[wallet.html + wallet.js<br/>Wallet]
        P[social.html + social.js<br/>Timeline, profiles, chat]
        L[lazy bundles<br/>swap.js · connect.js · qr.js]
    end
    subgraph Server["Express (src/server.ts)"]
        API[/api/*]
        SOC[/api/social/*]
        ST[static, precompressed]
    end
    S & W & P --> ST
    S --> API
    W --> API
    P --> SOC
    API --> BR[Brave Search]
    API --> HE[Helius RPC]
    API --> JU[Jupiter]
    SOC --> PG[(Postgres)]
    SOC --> FS[(photos on disk)]
```

There are three documents, and each is a static file. Nothing that depends on who is
asking is rendered into HTML, except the price strip that the server injects into
`index.html`. Each document inlines its own stylesheet and loads exactly one bundle.
Anything that is only needed after a click is a lazy bundle.

| Surface | Path | Document | Bundle | Lazy |
|---|---|---|---|---|
| Search | `/`, `/?q=` | `index.html` | `app.js` | `swap.js`, `connect.js`, `qr.js` |
| Wallet | `/wallet` | `wallet.html` | `wallet.js` | `connect.js`, `swap.js`, `qr.js`, `keys.js` |
| Social | `/social/*` | `social.html` | `social.js` | `qr.js` |

Every page's header ends with a **Wallet** button (a small pill with a wallet mark and the
word) and then the signed-in username, which opens My Profile, or **Get Social** when
nobody is signed in. Social remembers the name in `localStorage` (`ug.me`), so search
paints it without a request. There is no wallet Login in the header: an account comes with
a wallet, and the trade dialog connects a browser wallet only for visitors without one.

Chat is part of Social: one more tab and one more route in the same document and bundle,
served by the same API and stored in the same database.

### API / Interface

#### Pages

```text
GET /                         search home
GET /?q=<query>&lang=<code>   results; tabs: Web, Images
GET /?q=<sym>&buy=<mint>      results with the buy dialog open (wallet in-app browsers, QR hand-off)
GET /search?q=                302 → /?q=
GET /wallet                   left: holdings, 24h line, Receive/Send/Swap, Trending + search
                              right: the chosen token's line and market data
GET /icon/<mint>              token thumbnail, image/webp, 64 px
GET /social                   timeline
GET /social/saved             saved posts
GET /social/friends           friends, and search for people
GET /social/u/<name>          profile: card left, posts right (stacked on phones)
GET /social/p/<id>            one post with its comments
GET /social/c                 chat threads                      (new)
GET /social/c/<handle>        one conversation                  (new)
GET /social/a/<name>          profile photo, full
GET /social/t/<name>          profile photo, timeline copy
GET /social/i/<id>/<n>[?m=1]  post photo n; m=1 is the phone copy
GET /terms.pdf, /privacy.pdf
GET /healthz
```

#### Search and wallet

```text
GET  /api/search?q&lang&offset   → SearchApiResponse   (src/types.ts)
GET  /api/images?q&lang          → Brave image results
POST /api/balances {owner, mint?} → BalancesApiResponse
POST /api/holdings {owner}        → HoldingsApiResponse
GET  /api/tokens/top              → {tokens: TopToken[]}   30 verified mints by 24h volume
GET  /api/tokens?q=               → {tokens: TopToken[]}   the whole index: mint, symbol, name
GET  /api/tokens/<mint>           → TokenDetail            indexed mints only; Jupiter, cached 30 s
```

The wallet page reads the signed-in account's address, or a wallet connected in the trade
dialog when nobody is signed in. On a desktop it fills the viewport exactly: the holdings and
token lists scroll inside the left half, and the page itself never scrolls. `Holding` and `TopToken` carry `icon: true` when a thumbnail is
served at `/icon/<mint>`.

A browser wallet swaps against Jupiter (`lite-api.jup.ag`) directly. A signed-in account's
swap is quoted, built, signed and sent by the server; see Keys below.

#### Social

Every write requires a matching `Origin`. Errors have the form `{error: string}`.

- `401`: not signed in, and the client forgets the session.
- `403`: wrong password while signed in; the session is kept.
- `429`: throttled; the response has a `Retry-After` header.
- `503`: the database is unavailable.

```typescript
type Me = { name: string; address: string; bio: string; loc: string;
            avatarRev: number; passkey: boolean; wait: number; unseen: number };
type Card = { id: string; by: string; text: string; at: number; views: number;
              comments: number; saved: boolean; reposted: boolean; repost: string | null;
              repostBy: string | null; originalRev: number; avatarRev: number; photos: number };

POST /api/social/register      {username, password}          → {name, address}
POST /api/social/login         {username, password}          → {name} | {passkey: {challenge, id}}
POST /api/social/login/passkey {username?, id?, challenge, clientData, authenticatorData, signature} → {name}
POST /api/social/passkey/login {}                            → {challenge}
POST /api/social/recover       {phrase, password}            → {name}
POST /api/social/logout        {}                            → {ok}
GET  /api/social/me                                          → {me: Me | null}

GET  /api/social/timeline?before&id → {me, posts: Card[], notes, next: {at, id} | null}
GET  /api/social/saved              → {me, posts: Card[]}
GET  /api/social/u/<name>           → {me, user: {name, address, bio, loc, avatarRev, posts: Card[]}}
POST /api/social/open    {post}     → {me, post: Card, comments}
POST /api/social/post    {text} | application/octet-stream (text + up to 4 photos) → {post: Card}
POST /api/social/comment {post, text} → {comment}
POST /api/social/plus    {post}     → {saved}
POST /api/social/repost  {post}     → {ok}
POST /api/social/notes/seen {}      → {ok}

GET    /api/social/users?q=<prefix> → {me, users}
GET    /api/social/people?q=<name>  → {people: {name, bio, loc, avatarRev}[]}   public; up to 3, exact name first
GET    /api/social/friends          → {me, friends}
POST   /api/social/friends {username} → {friends}
DELETE /api/social/friends/<name>   → {friends}

POST /api/social/profile {bio?, loc?}    → {ok}
POST /api/social/avatar  u32 tinyLen, u32 fullLen, tiny JPEG, full JPEG → {avatarRev}
POST /api/social/phrase  {password}      → {phrase}
POST /api/social/phrase/passkey/options {} → {challenge, id}
POST /api/social/phrase/passkey {challenge, clientData, authenticatorData, signature}
                                         → {phrase} | 409 {setup: true}
POST /api/social/swap {inputMint, outputMint, amount, slippageBps ≤ 300} → {signature, outAmount}
POST /api/social/send {to, mint, amount}                                 → {signature}
POST /api/social/passkey/options {password} → {challenge, uid}
POST /api/social/passkey {id, challenge, clientData, attestation} → {ok}
POST /api/social/pay     {to, from, sol} → {transaction}   (unsigned; the payer's wallet signs)
```

#### Chat (new)

Chat uses the same session, `Origin` check, error shapes and write limiter as the rest of
Social. It adds `unread: number` to `Me`, so the Chat tab shows a count on every page
without a request of its own.

```typescript
type Thread = { with: string; avatarRev: number; last: string; at: number; unread: number };
type Message = { id: string; from: string; text: string; at: number };

GET  /api/social/c                     → {me, threads: Thread[]}          newest first
GET  /api/social/c/<name>?after=<at>   → {me, messages: Message[]}        oldest first; marks them seen
POST /api/social/c/<name> {text}       → {message: Message}
```

- A message is one line of text, up to 160 characters, checked by the same `shortText` as a
  comment. It has no photos, link previews, reactions or edits.
- Anyone signed in can message anyone. Being friends is not required, so a person can be
  reached from any connection, not only the ones they already have.
- Delivery is polling, not a socket. An open conversation asks for `?after=<last at>` every
  5 s while `document.visibilityState` is `visible`, and stops when the page is hidden.
  Every other page learns about new messages from `me.unread`.
- Every profile other than your own shows a **Message** button that opens
  `/social/c/<name>`.

### Data Model

The Postgres tables are defined once, in `SCHEMA` in `src/social/db.ts`, and nowhere else:

```text
users    name PK, uid, pass_salt, pass_hash, phrase_salt/iv/tag/ct, address UNIQUE, bio, loc,
         avatar_rev, last_post, created, passkey_id UNIQUE, passkey_cose, passkey_alg,
         passkey_count, epoch, key_iv/tag/ct
posts    id PK, by_name, text, at, views, photos, repost → posts.id  (UNIQUE repost, by_name)
comments id PK, post, by_name, text, at
notes    id PK, to_name, from_name, post, at, seen, kind            (newest 100 per person)
saves    post, by_name, at                                          (PK post, by_name)
friends  owner, friend                                              (PK owner, friend)
messages id PK, from_name, to_name, text, at, seen                  (new; newest 200 per pair)
```

Pictures are files, not rows:

```text
data/social/avatars/<name>.jpg     profile, ≤ 14 KB, width ≤ height, no crop
data/social/avatars/<name>.t.jpg   timeline copy, ≤ 2 KB, ≤ 80 px wide
data/social/posts/<id>-<n>.jpg     ≤ 48 KB, ≤ 1600 px edge
data/social/posts/<id>-<n>.m.jpg   phone copy, ≤ 14 KB, ≤ 640 px edge
.cache/icons/<mint>.webp           token logo, 64 × 64, about 1 KB; a cache, rebuilt by the sync
```

**Token thumbnails.** After each hourly index rebuild, the server fetches the logos of every
indexed mint, busiest first, that are missing or more than a week old. It shrinks each one
with `sharp` to 64 × 64 WebP and writes it to `.cache/icons`. An IPFS logo falls back to
Pinata's and then ipfs.io's gateway, and a logo that fails is retried on the next sync. The logo URL comes from token metadata that anyone can set, so it is
fetched only over `https`, from a named public host (no IP literals, `localhost`, `.local` or
`.internal`), with redirects followed by hand under the same rule, a 1 MB cap and an 8 s
timeout.

The limits live in `src/social/limits.ts`:

| What | Limit |
|---|---|
| Post, comment, bio | 160 characters, one line |
| Location | 40 characters |
| Photos per post | 4 |
| Comments per post | 100 |
| Friends | 200 |
| Time between posts | 10 minutes |
| Chat message | 160 characters, one line |
| Messages kept per conversation | 200, oldest dropped |

**Profile picture shape.** The picture is drawn at its own aspect ratio, anywhere from
square to portrait. The browser scales it before upload, and nothing crops it. It is shown
at 200 px wide on a profile and 40 px wide in a feed, with `height: auto` and
`border-radius: 0`. Every other image may round its corners, but a person may not.

### Flow

**Joining and recovering.**

```mermaid
sequenceDiagram
    participant U as Browser
    participant S as Server
    U->>S: POST /register {username, password}
    S->>S: 12-word phrase → Solana address; phrase sealed under password
    S-->>U: session cookie (epoch 0)
    U->>S: POST /phrase {password}
    S-->>U: phrase, shown once behind the password
    Note over U: later, password forgotten
    U->>S: POST /recover {phrase, new password}
    S->>S: address from phrase → account; reseal; clear passkey; epoch + 1
    S-->>U: new session; every older cookie is refused
```

**Keys.** Each account's phrase is sealed twice: under the person's password (scrypt,
`phrase_*`) and under `WALLET_KEY` from the environment (AES-256-GCM, `key_*`). The second
copy is what lets the server sign, so trading needs no wallet app and no prompt.
`WALLET_KEY` is required in production and never stored in Postgres, so a copy of the
database opens no key. No response carries key material; `scrub` in `guard.ts` removes the
columns if a handler ever tries. Accounts made before `key_*` get it at their next password
entry; until then swap, send and passkey reveal answer `409 {setup: true}`.

**Swapping and sending.** The server signs only what it built or fetched itself:

1. Swap: the browser quotes for display, then posts the pair, amount and slippage. The
   server asks Jupiter for its own quote and transaction for the account's address, checks
   that the transaction has exactly one signer and that the signer is the account, signs,
   and submits through Helius. The output always lands in the account's own token account.
2. Send: the server compiles the transfer itself. SOL is a system transfer. A token first
   opens the recipient's associated token account (idempotent, paid by the sender), then
   `TransferChecked`, so a brand-new wallet can receive anything.
3. A rent failure ("Every Solana account must keep about 0.001 SOL") is explained, not
   reported as a generic error.

**The wallet page's dialogs** live in `keys.js`: Recovery phrase (password or passkey),
Receive (address as a QR code, plus Copy), and Send (token, recipient with Paste, amount
with Max).

**Paying someone.**

1. On a profile, **Pay via QR code** opens a dialog with the owner's address as a QR code.
2. On a phone, the camera hands the address to a wallet app.
3. On a computer, the user enters an amount. `POST /pay` returns an unsigned transfer, and
   the browser's wallet signs and sends it. The server never holds the payer's key.

**Chatting.**

1. On a profile, **Message** opens `/social/c/<name>`. The page loads the last 200 messages
   of that conversation in one request.
2. Sending posts one line. The message is appended to the list as soon as the server
   returns it; there is no optimistic copy to reconcile.
3. While the conversation is visible, it polls for newer messages every 5 s. Opening a
   conversation marks its messages seen and lowers `me.unread`.

## Constraints

**Bytes**

- Every first-flight response is at most **14,250 B gzip**: one TCP initial window, less the
  headers. `index.html` gets 13,950 B, because the server injects the price strip into it.
  The build fails when any response is over budget.
- Each bundle has a raw parse budget: `app.js` and `social.js` 24,576 B, `wallet.js`
  16,384 B. Going over prints a warning, not a failure.
- Stylesheets are inlined. The social document is pruned at build time to the selectors its
  bundle and markup can produce.
- Assets are precompressed at build time: brotli quality 11 and gzip -9.

**Dependencies**

- Server runtime dependencies: `express`, `compression`, `pg`, `sharp`. Adding a dependency
  needs a trade-off entry in this spec.
- Client runtime dependencies: none. No framework and no web fonts.
- Build: esbuild, lightningcss, html-minifier-terser.

**Browser-native first**

- Font: `system-ui, Helvetica, Arial, sans-serif`. Weights 400–700.
- Theme: `color-scheme: light dark` and `prefers-color-scheme`. Controls and scrollbars
  follow the system.
- Use native controls before building one:

  | Need | Native control |
  |---|---|
  | Modal | `<dialog>` |
  | Validation | `required`, `minlength`, `maxlength` |
  | Language picker | `<select>` |
  | Photo picker | `<input type="file">` |
  | Search field | `<input type="search">` |
  | Images | `loading="lazy"`, `decoding="async"` |

- Branding is limited to the wordmark, one green (`--go #39a11c`, `--buy #167c3c`),
  pill-shaped primary buttons, and the search field.
- Targets: ES2020; Chrome 90, Firefox 90, Safari 14.1.

**Code**

- Plain functions and modules. No classes, decorators, or build-time magic in client code.
  No TypeScript syntax in `client/`.
- No comments that restate code. A comment is allowed only for a constraint the code cannot
  show: a protocol quirk, a budget, or a browser bug. It gets one line.
- Scripts log failures and one line of result. They do not print banners, progress, or
  explanations.
- One source per fact. The schema lives in `db.ts`, limits in `limits.ts`, and budgets in
  `build-client.mjs`.
- DOM through `el()`/`$()` from `client/js/dom.js`. Lazy code through `load()` from
  `client/js/lazy.js`. Wallets through `client/js/wallet.js`.

**Availability and security**

- Search never depends on Postgres. Only `/api/social` answers `503`.
- A query that could be a username (`@`optional, 3–16 of `a-z0-9_`) also asks `/api/social/people`
  alongside `/api/search`. Matches show as cards above the results; nothing waits on them.
- Passwords are hashed with scrypt at N=2^15, off the event loop. Hashes from an older cost
  are resealed at login.
- Sessions are HMAC cookies that carry the account's `epoch`. Recovery bumps the epoch.
- There are separate rate limits for login, recovery, secrets, payments, writes, and
  search. On top of those, a 15-minute lock follows 10 wrong passwords on one account.

**User input**

Everything a person types, uploads or puts in a URL is untrusted. That covers posts,
comments, chat messages, bio, location, usernames, search queries, `?q=`, `?buy=` and
`?lang=`. It is also true of what comes back from Brave, Helius and Jupiter. None of it is
ever executed or parsed as markup in the browser.

- **Sanitize on the server, on the way in.** Every field goes through one validator in
  `src/social/limits.ts` before it is stored or used, and a field without one is refused.
  - Text passes through `shortText`/`postText`. These replace control characters, collapse
    whitespace, trim and enforce the length. The validators also remove bidirectional
    override characters (U+202A–U+202E, U+2066–U+2069), so a line cannot display reversed.
  - Names match `NAME`, and ids match their own format. `lang` must be on the allow-list the
    picker offers. A mint must decode as a 32-byte base58 key.
  - An upload must parse as a JPEG (`jpegSize`) within its byte and pixel limits, and is
    stored and served only as `image/jpeg`.
- **Store text as the person wrote it, and escape it on the way out.** The database never
  holds HTML-escaped text, so nothing is escaped twice and no escaping step can be
  forgotten on a second path.
- **Render as text, never as markup.** User and third-party values reach the DOM only
  through `textContent` (`el(tag, {text})`), `setAttribute`, or `img.src`. `innerHTML`,
  `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function`, and
  string arguments to `setTimeout`/`setInterval` never receive them. The one allowed use of
  `innerHTML` is a string built entirely from values the same function computed, such as
  chart paths or a QR code. It carries a one-line comment saying so.
- **No link, style or handler taken from input.** Links point only at paths the client
  builds from a validated name or id (`/social/u/<name>`, `/social/p/<id>`). A URL from a
  person is shown as text and never becomes an `href`. A URL from a search result
  becomes an `href` only when its scheme is `http:` or `https:`. No input becomes a `style`,
  a class name, or an `on*` attribute.
- **The browser enforces the same rules.** Every document is served with the CSP in
  `src/server.ts`: `script-src 'self'` with no inline script, `object-src 'none'`,
  `base-uri 'none'` and `frame-ancestors 'none'`. Every response also carries
  `X-Content-Type-Options: nosniff`. The API answers only `application/json`, people's
  pictures only `image/jpeg`, and token thumbnails only `image/webp`, re-encoded by the server. An injection that slips past the rules above still cannot run.
- **Tests keep it true.** `social.test.ts` posts payloads such as `<img src=x onerror=…>`,
  `javascript:` URLs and control or bidirectional characters through every write route. It
  asserts that each is stored as plain text or refused.

## Trade-offs

- **Decision:** Static documents with one inlined stylesheet each, no SPA router
  - *Why:* Each page paints from its first flight and is cacheable as a file. A route change
    is a full page load of about 8 KB.
  - *Alternatives rejected:* An SPA shell, which has a larger first load and needs
    scroll-restoration code. SSR per request, which varies the HTML and blocks
    precompression.

- **Decision:** Profile pictures at their own aspect ratio, never cropped or rounded
  - *Why:* It is the product's one deliberate visual signature, and it costs nothing: the
    rule is `height: auto`.
  - *Alternatives rejected:* Circles, which are the platform default and exactly what this
    rejects. Cut-out shapes as transparent PNG or WebP, which do not fit the 14 KB profile
    ceiling. A per-person outline stored as a CSS `clip-path` polygon would cost only a few
    bytes (see Open Questions).

- **Decision:** Native controls and system fonts over a design system
  - *Why:* Zero bytes, familiar to every user on their own OS, and accessible by default.
  - *Alternatives rejected:* A component library, which costs more than the entire page
    budget.

- **Decision:** Chat as a `messages` table next to `posts`, delivered by polling
  - *Why:* It reuses the session, limits, guard and database that Social already has, and
    adds one table, three routes and no dependency. Polling a visible conversation every
    5 s costs one small request and survives every proxy, VPN and in-app browser.
  - *Alternatives rejected:* WebSockets or server-sent events, which need connection state
    on the server and break behind some proxies. A self-custodial public log (the earlier
    Corpus draft), which keeps messages off our server but needs keys on the device, an
    indexer and a protocol of its own before the first message can be sent.

- **Decision:** Photos as files on disk, rows in Postgres
  - *Why:* Timeline queries stay small, and files serve with a one-day cache.
  - *Alternatives rejected:* Bytes in rows, which bloat every card query. Object storage,
    which adds a dependency before there is a need (see Open Questions).

- **Decision:** `sharp` to make token thumbnails on the server
  - *Why:* Logos arrive as PNG, JPEG, WebP, GIF and SVG from any host, at any size. Serving
    our own 1 KB WebP copy keeps the wallet page's thirty images small, keeps third-party
    hosts out of `img-src`, and means a visitor's browser never contacts them.
  - *Alternatives rejected:* Hot-linking the logos, which costs the full original bytes
    and tells the logo host who is looking. An image proxy such as wsrv.nl, which is a
    free service with no guarantee. Decoding the formats by hand, which is the opposite of
    maintainable.

- **Decision:** The server holds a sealed copy of every key and signs for the account
  - *Why:* A superapp has to trade and send in one tap, with no wallet app and no seed
    phrase to manage. Keeping `WALLET_KEY` out of the database means a database leak
    alone exposes nothing, and signing only server-built transactions means a stolen
    session can't send funds to an arbitrary address through a swap.
  - *Alternatives rejected:* Browser wallets only, which is the friction this replaces.
    WebAuthn PRF (the passkey derives the key), which needs a password step on first use
    and fails on browsers without PRF. Signing any transaction the browser hands over,
    which turns a session into a blank cheque.

- **Decision:** Prune the social stylesheet at build time instead of splitting app.css
  - *Why:* Social reuses the results layout. Keeping one source avoids drift, and pruning
    saves about 2 KB gzip per load.
  - *Alternatives rejected:* A shared `shell.css`, which would need a manual split of a
    2,000-line sheet in cascade order.

## Open Questions

- [ ] **Unwanted messages.** Anyone can message anyone. Is the rate limit enough, or does a
      person need a way to mute a sender, or to see messages from non-friends separately?
- [ ] **How long messages are kept.** The spec keeps the newest 200 per conversation. Should
      messages also expire by age, so the server holds as little as possible?
- [ ] **Shapes beyond the photo's own outline.** Today a picture's shape is its aspect ratio.
      Should a person also be able to draw an outline, stored as a short `clip-path` polygon on
      their `users` row and applied on the profile and in feeds?
- [ ] **How tall a profile picture may be.** Nothing bounds it today. Is a 1:2 ratio the
      ceiling?
- [ ] **Existing code versus the code rules.** The current source carries long "why" comments,
      JSDoc types in `client/`, and a multi-paragraph build report. Is it stripped when a
      file is next touched, or in one pass? Are JSDoc type annotations allowed where `tsc`
      checks the client?
- [ ] **Photos on Railway's disk** are lost on redeploy unless a volume is attached. Should
      that be a volume, or object storage?
- [ ] **Volume or organic volume.** The most-traded list sorts by raw 24h volume from
      Jupiter. Wash trading inflates it for some tokens. Should it sort by
      `buyOrganicVolume + sellOrganicVolume` instead?
- [ ] **Session theft.** A stolen session can swap and send. Should sends above an amount,
      or to a new address, ask for the password or passkey again?
- [ ] **Jupiter's keyless budget.** Server-side swaps spend from the same per-IP budget
      as the hourly index. Is it time for an `api.jup.ag` key?
- [ ] **A leftover `data/social/db.json`** from an earlier store holds old hashes and sealed
      phrases. Should it be deleted?

## Out of Scope

- Group chats, media in messages, voice, and video.
- Notifications outside the page (push, email).
- Moderation tooling beyond the rate limits and the per-account lock.
- End-to-end encryption of messages. The server can read them, the same as posts.
- Custom themes, dark-mode toggles, and user-chosen accent colours. The system decides.
- Native apps. The web app is the app, including inside wallet in-app browsers.
- Search index or crawler of our own. Results come from Brave.

## References

- [brand.md](../brand.md): budget model and palette
- RFC 6928: the initial congestion window of 10 segments
