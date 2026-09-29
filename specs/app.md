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
        L[lazy bundles<br/>swap.js · connect.js · qr.js · login.js · hive.js]
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
| Search | `/`, `/?q=` | `index.html` | `app.js` | `swap.js`, `connect.js`, `qr.js`, `login.js`, `hive.js` |
| Wallet | `/wallet` | `wallet.html` | `wallet.js` | `connect.js`, `swap.js`, `qr.js`, `keys.js`, `login.js` |
| Social | `/social/*` | `social.html` | `social.js` | `qr.js`, `chat.js` |

Every page wears the same header as search: the wordmark, the search field, and the
account control. Signed in, the control is a **Wallet** button (a small pill with a wallet
mark and the word) and then the username, which opens My Profile. Signed out, the Wallet
pill is a **Log in** pill (a person mark) that opens the login dialog in place, followed by
**Get Social** (on Social itself, Go Search). Social remembers the name in `localStorage`
(`ug.me`), so search paints it without a request. Log in is always the Social account; the
trade dialog connects a browser wallet only for visitors without one.

There is one login dialog (`client/js/login.js`): log in, create an account, or recover
one. Social bundles it; search and the wallet page fetch it as `login.js` on the first
click. Every Log in button, in a header or on a page, opens it and never navigates away.

Messenger is part of Social: one more tab and one more route in the same document, with
its own lazy bundle (`chat.js`), served by the same API and stored in the same database.

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
GET /social/edit              edit profile: photo, bio, location, passkey, recovery phrase
GET /social/p/<id>            one post with its comments
GET /social/c                 Messenger: chats left, "pick a chat" right
GET /social/c/<handle>        Messenger with that conversation open
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
            avatarRev: number; passkey: boolean; wait: number; unseen: number; unread: number };
type Card = { id: string; by: string; text: string; at: number; views: number;
              comments: number; saved: boolean; reposted: boolean; repost: string | null;
              repostBy: string | null; originalRev: number; avatarRev: number; photos: number };

POST /api/social/register      {username, password}          → {name, address}
POST /api/social/login         {username, password}          → {name} | {passkey: {challenge, id}}
POST /api/social/login/passkey {username?, id?, challenge, clientData, authenticatorData, signature} → {name}
POST /api/social/passkey/login {}                            → {challenge}
POST /api/social/recover       {phrase, password}            → {name}
POST /api/social/logout        {}                            → {ok}   ends every session of the account
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
POST /api/social/swap {inputMint, outputMint, amount, slippageBps ≤ 300, quotedOut}
                      → {signature, outAmount} | 409 {requote: true}
POST /api/social/send {to, mint, amount, password? | challenge, clientData, authenticatorData, signature}
                      → {signature} | 403 {stepUp: true, passkey}
POST /api/social/send/passkey/options {} → {challenge, id}
POST /api/social/passkey/options {password} → {challenge, uid}
POST /api/social/passkey {id, challenge, clientData, attestation} → {ok}
POST /api/social/pay     {to, from, sol} → {transaction}   (unsigned; the payer's wallet signs)
```

#### Messenger

Messenger uses the same session, `Origin` check, error shapes and limiters as the rest of
Social. `Me` gains `unread: number`, so the Messenger tab shows a count on every page
without a request of its own.

Messages are end-to-end encrypted. The server stores public keys, ciphertext, and who
wrote to whom and when; it never holds a key that opens a message.

```typescript
type ChatKey = { v: number; pub: string; cred: string; iv: string; ct: string };
type Message = { id: string; from: string; at: number; kf: number; kt: number;
                 iv: string; ct: string; photos: number };
type Chat = { with: string; avatarRev: number; at: number; unread: number;
              pub: string | null; last: Message };

GET  /api/social/ck                         → {cred: string | null, key: ChatKey | null}
POST /api/social/ck/options {}              → {challenge, id}
POST /api/social/ck {pub, iv, ct, challenge, clientData, authenticatorData, signature} → {v}
GET  /api/social/c[?before=<at>&peer=<name> | ?after=<at>]
                                            → {me, chats: Chat[], next: {at, peer} | null}
GET  /api/social/c/<name>[?before=<at>&id= | ?after=<at>&id=]
                                            → {me, peer?: {name, avatarRev, keys: {v, pub}[]},
                                               messages: Message[], next: {at, id} | null}
POST /api/social/c/<name>  application/octet-stream → {message: Message} | 409 {stale: true}
GET  /api/social/cp/<id>/<n>                → sealed photo bytes, to the two people only
```

- **Keys.** Turning Messenger on makes an ECDH P-256 key in the browser. Its private half
  (PKCS#8) is sealed with AES-GCM under HKDF(PRF output of the account's passkey), and
  `pub`, `iv`, `ct` and the passkey's credential id (`cred`) are stored as the next version
  in `chat_keys`. Publishing needs a passkey assertion the server verifies, so a stolen
  session alone cannot swap in its own key. Old versions stay, so the other person can
  still open what was sealed to them.
- **Opening on a device.** The passkey's PRF output opens the box, and the key is kept in
  IndexedDB (`ug-chat`) as a non-extractable `CryptoKey`: one passkey prompt per device,
  none per visit. Logging out deletes the store.
- **Sealing.** A conversation key is HKDF(ECDH(mine, theirs)), with both names and key
  versions as `info`. Text is AES-GCM with `from>to` as additional data; each photo is its
  own IV and AES-GCM over the JPEG, with `from>to <message iv> <n>` as additional data. The
  POST body is a u16 header length, the header JSON `{kf, kt, iv, ct}`, a photo count,
  then each sealed photo as a u32 length and its bytes.
- **Stale keys.** `kf` and `kt` must be both people's newest versions. Otherwise the POST
  is `409 {stale: true}`, and the client fetches the keys again and reseals.
- A message is up to 500 characters and any number of lines, with up to four photos (the
  post composer's photo button and strip). Enter sends; Shift+Enter is a new line.
- Anyone signed in can message anyone who has turned Messenger on. Being friends is not
  required. Someone without a key is shown as not reachable yet.
- **The sidebar** is a filter input ("Message @handle") above the chats, newest first. The
  input narrows the loaded chats and suggests matching people to start a chat with. The
  list pages 30 at a time as it scrolls. A chat with unread messages shows **"N new
  messages"** in bold green instead of its preview.
- **The conversation** pages 30 messages at a time upward as it scrolls, keeping its
  place. The composer sits on the bottom edge of the page. On a phone the list and the
  conversation are separate screens.
- Delivery is polling, not a socket. While the page is visible, `?after=` on the chat list
  runs every 5 s. A moved conversation that is open pulls its new messages, which also
  marks them read.
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
chat_keys name, v, pub, cred, iv, ct, at                          (PK name, v)
messages id PK, pair, from_name, to_name, at, kf, kt, iv, ct, photos   (newest 1,000 per pair)
chats    owner, peer, at, last → messages.id, unread               (PK owner, peer)
```

Pictures are files, not rows:

```text
data/social/avatars/<name>.jpg     profile, ≤ 14 KB, width ≤ height, no crop
data/social/avatars/<name>.t.jpg   timeline copy, ≤ 2 KB, ≤ 80 px wide
data/social/posts/<id>-<n>.jpg     ≤ 48 KB, ≤ 1600 px edge
data/social/posts/<id>-<n>.m.jpg   phone copy, ≤ 14 KB, ≤ 640 px edge
data/social/chat/<id>-<n>.bin      sealed message photo: IV + AES-GCM(JPEG ≤ 48 KB)
data/cache/icons/<mint>.webp       token logo, 64 × 64, about 1 KB; a cache, rebuilt by the sync
```

**Token thumbnails.** After each hourly index rebuild, the server fetches the logos of every
indexed mint, busiest first, that are missing or more than a week old. It shrinks each one
with `sharp` to 64 × 64 WebP and writes it to `data/cache/icons`. An IPFS logo falls back to
Pinata's and then ipfs.io's gateway, and a logo that fails is retried on the next sync. The logo URL comes from token metadata that anyone can set, so it is
fetched only over `https`, from a named public host (no IP literals, `localhost`, `.local` or
`.internal`), with redirects followed by hand under the same rule, a 1 MB cap and an 8 s
timeout.

The limits live in `src/social/limits.ts`:

| What | Limit |
|---|---|
| Post | 256 characters, one line |
| Comment, bio | 160 characters, one line |
| Location | 40 characters |
| Photos per post | 4 |
| Comments per post | 100 |
| Friends | 200 |
| Time between posts | 10 minutes |
| Message | 500 characters, 4 photos |
| Messages kept per conversation | 1,000, oldest dropped with their photos |

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

1. Swap: the browser quotes for display, then posts the pair, amount, slippage and the
   output it showed (`quotedOut`). The server asks Jupiter for its own quote; one below
   `quotedOut` less the slippage is refused (`409 {requote: true}`), and the slippage it
   builds with is narrowed so Jupiter's on-chain minimum stays at or above that floor.
   Before signing, the transaction must have one signer, the account, as fee payer, and
   every instruction must be Jupiter's program or one of the few forms around it: compute
   budget (priority fee capped), funding and syncing the account's own wrapped SOL,
   opening the account's own token accounts, and closing them back to the account. A
   simulation then has to show at most `amount` leaving, at least the floor arriving in
   the account's own token account, and no more SOL spent than fees and rent. Only then
   is it signed and submitted through Helius.
2. Send: the server compiles the transfer itself. SOL is a system transfer. A token first
   opens the recipient's associated token account (idempotent, paid by the sender), then
   `TransferChecked`, so a brand-new wallet can receive anything. A session alone may send
   up to $25 a day, valued from the token index; beyond that, or for a token the index
   cannot price, the request needs the password or a passkey assertion and otherwise gets
   `403 {stepUp: true}`. The dialog always shows a review step with the full address.
3. A rent failure ("Every Solana account must keep about 0.001 SOL") is explained, not
   reported as a generic error.

**Places.** Every link someone follows off search to another host (click or middle
click) is kept in `localStorage` (`tr`), and nowhere else: one entry per host with the
favicon, newest first, each holding its pages (URL, link text) newest first. At most 120
hosts and 60 pages a host.

1. Web, news, video and discussion results carry `meta_url.favicon`, Brave's 32 px proxy
   URL, passed through only when it is on `imgs.search.brave.com`. Results never draw it.
2. With a trail, home shows a hexagon button centred under the price strip. It is
   absolutely placed, so appearing after boot moves nothing. It loads `hive.js`, which
   injects its own sheet.
3. `hive.js` fills the page under the search header, which switches to its results row
   and stays usable; a search or the wordmark closes Places. Each host is its 32 px
   favicon in a grey circle, newest in the middle and the rest in hexagonal rings. The canvas is a native scroll box sized to
   the honeycomb, so panning (touch, trackpad, or mouse drag) stops at its edges.
4. A host zooms into its pages, which ring it the same way; the host again folds them
   back. Edit removes a host or a page, and Clear all forgets the trail.

**The wallet page's dialogs** live in `keys.js`: Recovery phrase (password or passkey),
Receive (address as a QR code, plus Copy), and Send (token, recipient with Paste, amount
with Max).

**Paying someone.**

1. On a profile, **Pay via QR code** opens a dialog with the owner's address as a QR code.
2. On a phone, the camera hands the address to a wallet app.
3. On a computer, the user enters an amount. `POST /pay` returns an unsigned transfer, and
   the browser's wallet signs and sends it. The server never holds the payer's key.

**Messaging.**

1. With no passkey on the account, Messenger asks for the password and adds one in place,
   the same enrolment the profile runs. Then **Turn on Messenger**: one more passkey
   prompt (browsers want a fresh tap for it) makes the key, seals it, and proves it to the
   server.
2. On another device, or after the store was cleared, **Unlock messages** asks the passkey
   once and opens the stored box. A passkey that was replaced cannot open the old box, so
   the page offers **Start a new key**; messages sealed to the old key stay closed there.
3. Typing a handle into the filter and pressing Enter, a suggestion, or a profile's
   **Message** button opens a conversation. Sending appends the message once the server
   returns it; there is no optimistic copy to reconcile.

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

**One design language across the super app**

Search, the wallet page, Social and Messenger are one app, so the same action looks, reads
and behaves the same wherever it appears. Before adding a button, reuse the one that
already exists for that action.

- **One header.** Every page has search's header: wordmark, search field, account control.
  Its rules live once, in `header.css` and `acct.css`, which the build appends to every
  page's sheet; a page's sheet adds to them and never copies them. That is also what lets
  the wallet page have the header without inlining the rest of `app.css`.
- **One component per action.** Log in is `.ac-in` in a header and `.ac-go` on a page, and
  both open the one login dialog. A dialog shared by several pages is one module (see
  `login.js`, `ui.js`), not a copy per page.
- **One label per action.** The words live in one constant (`LOGIN` in `acct.js`) and are
  not respelled: "Log in", not "Sign in" or "Login".
- **One set of shapes.** Header controls are small outlined pills. The primary action on a
  page or in a dialog is a filled `--buy` pill. Secondary actions are text buttons.
- **No reserved space for what is not there.** An empty error or status line takes no
  room; it appears when it has something to say.
- **Same layout for the same state.** A side panel that stands alone (Messenger's chat
  list, a profile card, the signed-out Log in panel) is the left column.
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
- Sessions are HMAC cookies that carry the account's `epoch`. Recovery and logout bump
  the epoch, so logging out ends the session on every device. The signing key is
  `SOCIAL_SECRET` when set, otherwise derived from `WALLET_KEY`: stable across boots and
  disks, and never a constant in the source.
- Every `/api/social` route has a per-address rate limit. Anything that checks a password
  (login, phrase, adding a passkey, confirming a send) shares one limit of 3 a minute;
  registering and recovery each allow 3 a minute. Per account, 3 wrong passwords a minute
  or 10 in 15 minutes hold further guesses back.
- Every server call to `lite-api.jup.ag` (hourly index, detail panel, swaps) spends from
  one budget in `lib/jupiterGate.ts`, under Jupiter's keyless per-IP limit, with a reserve
  only trades may use. A 429 pauses all of them for its `Retry-After`. The detail panel
  asks Jupiter only when it is opened on data older than a minute, and falls back to the
  last answer.
- Token logos are fetched only from public addresses (the resolver the socket uses
  refuses private ones), only as PNG, JPEG, GIF, WebP or AVIF, and resized with a
  5-second limit. libuv's pool is 16 threads so hashing and resizing don't hold up files.

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

- **Decision:** Messages end-to-end encrypted, keys sealed under the passkey's PRF
  - *Why:* Conversations are private in a way posts are not, and a database copy or a
    curious operator should read nothing. The passkey already exists for sign-in, so it
    is the key-holder with no new secret to manage, and asking it once per device keeps
    Messenger as effortless as the rest of the app.
  - *Alternatives rejected:* Server-held keys like the wallet's, which would not be end to
    end. A password-derived key, which the server sees at every login. Per-message
    ephemeral keys (forward secrecy), which need prekeys and a ratchet before the first
    message.
  - *Cost:* Messenger needs a passkey whose authenticator supports PRF. Losing every copy
    of the passkey, or recovering the account with the phrase, loses this side of the
    history.

- **Decision:** Chat as `messages` and `chats` tables next to `posts`, delivered by polling
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

- [ ] **Key verification.** The server hands out public keys, so it could hand out its own.
      Should a conversation show a safety number both people can compare?
- [ ] **Unwanted messages.** Anyone can message anyone. Is the rate limit enough, or does a
      person need a way to mute a sender, or to see messages from non-friends separately?
- [ ] **How long messages are kept.** The spec keeps the newest 1,000 per conversation. Should
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
- [x] **Photos on Railway's disk** are lost on redeploy unless a volume is attached. Should
      that be a volume, or object storage? A volume: `data-volume` at `/app/data` holds
      both `data/social` and `data/cache`, since a service may mount only one. It pins the
      service to one replica; more than that means object storage.
- [ ] **Volume or organic volume.** The most-traded list sorts by raw 24h volume from
      Jupiter. Wash trading inflates it for some tokens. Should it sort by
      `buyOrganicVolume + sellOrganicVolume` instead?
- [ ] **Jupiter's keyless budget.** Server-side calls share one budget of 50 a minute, with a
      reserve for trades. If trading grows past that, is it time for an `api.jup.ag` key?
- [ ] **A leftover `data/social/db.json`** from an earlier store holds old hashes and sealed
      phrases. Should it be deleted?

## Out of Scope

- Group chats, voice, and video.
- Notifications outside the page (push, email).
- Moderation tooling beyond the rate limits and the per-account lock.
- Custom themes, dark-mode toggles, and user-chosen accent colours. The system decides.
- Native apps. The web app is the app, including inside wallet in-app browsers.
- Search index or crawler of our own. Results come from Brave.

## References

- [brand.md](../brand.md): budget model and palette
- RFC 6928: the initial congestion window of 10 segments
