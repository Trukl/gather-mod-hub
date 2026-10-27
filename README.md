# Gather Mod Hub

API of the **community hub** of the [Gather Mod Menu](https://github.com/Trukl/gather-mod-menu): stores and shares outfit, desk and construction presets, and the object animations of each map. Cloudflare Worker + D1 (SQLite), deployed at `https://gather-mods-hub.minnecorentin.workers.dev`.

CORS only allows the `https://app.v2.gather.town` origin.

## Sign-in with the Gather account

The mod reads Gather's Firebase ID token from the page and sends it to `POST /auth`. The hub checks its signature against Google's public keys, its issuer (`securetoken.google.com/gather-town-v2`), audience and expiry, keeps only the Gather account id (`gather.userAccountId`, never the token nor the email) and answers a hub session valid 30 days, signed with `SESSION_SECRET`. Requests then send `Authorization: Bearer <session>`. From Core 1.8.0, the mod sends the Gather token to `/auth` only: install reports and presence pings carry the hub session too (older cores still send the token in their body, which the hub still accepts).

Presets and animations created with a session belong to that Gather account (`ownerId`, never returned): every client of that account can delete or start/stop them, and lists flag them with `mine: true`. Items created before sign-in keep their `deleteToken`/`editToken` until `POST /auth/claim` hands them to the account.

From 2026-10-20 16:30 UTC (`SIGN_IN_REQUIRED_FROM`), every route but `POST /auth` requires a session (or `ADMIN_TOKEN`): requests without one get `401 sign in required`, so only people signed in to Gather with the mod can read or publish. Until then, mods that don't sign in yet (before Community hub 1.1.0 / Fun 1.3.0) are still served.

## Required updates

From Core 1.4.0, the mod sends the versions of its running modules with every request, in the `X-Gather-Mods` header (`core=1.4.0,hub-api=1.3.0,…`). The hub reads the published catalog of the mod (key `catalog:latest` of the release worker's `RELEASES` KV namespace, cached 5 minutes): a changelog entry marked `"breaking": true` is the minimum version of its module. When a running module is below it, every route but `POST /installs` answers `426 { error: "update required", modules: [{ id, changelog: [breaking entries it misses] }] }`, and the mod opens its “Update required” window. Requests without the header (mods before Core 1.4.0) are not checked.

## API

| Method   | Route                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth`                        | `{ gatherToken }` → `{ session, expiresAt }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST`   | `/auth/claim`                  | With a session: `{ presets: [{ type, id, token }], animations: [{ floorId, id, token }] }` → `{ claimed: [ids] }`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`    | `/presets/:type?q=`            | List (100 max, newest first), with the full preset and `mine`. `q` filters on name, author and content.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST`   | `/presets/:type`               | Publishes `{ author, data }`. Answers `{ id, type }` (plus `deleteToken` when not signed in).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DELETE` | `/presets/:type/:id`           | Deletes, with `Bearer <owner's session \| deleteToken \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`    | `/animations/:floorId?map=`    | Animations of a Gather floor with `mine`, and the server time `now` (clients sync their clock on it). With `map`, also `legacy`: the animations still stored for that map version, with `movable` when the caller can move them without a token (its own, or nobody's).                                                                                                                                                                                                                                                   |
| `POST`   | `/animations/:floorId`         | Creates `{ author, data }`, running. Answers `{ animation, now }` (plus `editToken` when not signed in).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST`   | `/animations/:floorId/migrate` | With a session: `{ mapId, items: [{ id, objects, token? }] }` moves the caller's legacy animations of that map version to the floor with the given object references: its own, those nobody owns, and those whose `editToken` it sends (handed to its account). The caller's animations without references are dropped; the others stay until their owner moves them. Answers `{ now, items }`.                                                                                                                           |
| `PATCH`  | `/animations/:floorId/:id`     | `{ running }` starts (from the beginning) or stops it; `{ data }` replaces its name and movement (same format as on creation) and restarts it. With `Bearer <owner's session \| editToken \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                               |
| `DELETE` | `/animations/:floorId/:id`     | Deletes, with `Bearer <owner's session \| editToken \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST`   | `/installs`                    | With a session: `{ installId, launcher, versions: { core: "1.3.0", … } }`: the mod's core reports its installed module versions on first install and after each update; the account id is kept with the report. Cores before 1.8.0 send `gatherToken` in the body instead, verified like `/auth`.                                                                                                                                                                                                                         |
| `POST`   | `/presence`                    | With a session: `{ hidden, accounts: [accountId, …] }` (500 accounts max, 150 pings an hour): the mod's core pings every 2 minutes while it runs (cores before 1.8.0 send `gatherToken` in the body instead, verified like `/auth`). `hidden: false` records when the caller's account last ran the mod (only the account id and the time are kept); `hidden: true` deletes that record. Answers `{ active: [accountId, …] }`: the given accounts that ran the mod in the last 5 minutes, which the mod marks on the map. |
| `GET`    | `/stats`                       | With `ADMIN_TOKEN`: `{ installs, accounts, launcher, updatedLast30Days, modules: { id: { version: count } }, items }`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`    | `/announcements`               | Active announcements, without session: `{ announcements: [{ id, title, message, level, createdAt, expiresAt, outdated? }] }`. One with `outdated` is only listed for mods whose `X-Gather-Mods` header shows one of those modules below that version (all of them for `ADMIN_TOKEN`).                                                                                                                                                                                                                                     |
| `POST`   | `/announcements`               | With `ADMIN_TOKEN`: `{ title, message, level: "info" \| "warning", hours, outdated? }` (title 60 and message 500 characters max, 24 hours by default, 30 days max; `outdated`: `{ moduleId: "x.y.z" }`). Answers `{ announcement }`.                                                                                                                                                                                                                                                                                      |
| `DELETE` | `/announcements/:id`           | With `ADMIN_TOKEN`: removes it before it expires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`    | `/objects/:floorId`            | Custom objects of a Gather floor, in creation order, with `mine`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST`   | `/objects/:floorId`            | With a session: creates `{ author, data }`. Answers `{ object }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PATCH`  | `/objects/:floorId/:id`        | `{ data }` replaces it, with `Bearer <owner's session \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE` | `/objects/:floorId/:id`        | Deletes, with `Bearer <owner's session \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST`   | `/images`                      | With a session: the raw image (`Content-Type` `image/png`, `jpeg`, `gif` or `webp`, 512 KB max). Answers `{ url: "/images/:id" }`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`    | `/images/:id`                  | The image, public and cached for a year (its id never changes).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DELETE` | `/images/:id`                  | With `Bearer <owner's session \| ADMIN_TOKEN>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`type` is `outfit`, `desk` or `construction`.

### Preset formats

- **outfit**: `{ name, outfit: { skin, hair, facialHair, top, jacket, bottom, shoes, hat, glasses, other, costume, mobility }, summary }`. Every slot is optional and must be a Gather wearable UUID.
- **desk**: `{ name, items: [{ variant, name, x, y, children: [...] }], area?: { width, height } }`. `variant` is a `CatalogItemVariant` UUID; `x`/`y` are in tiles, relative to the desk's top-left corner (or to the parent object for `children`).
- **construction**: `{ name, items }`, same `items` as `desk`, with `x`/`y` relative to the tile-aligned top-left corner of the group.

### Animation format

`{ name, type, objects: [{ hash, variant, x, y }], point: { x, y }, params: { period, direction, amplitude, waves } }`: `type` is `orbit`, `line` or `wave`; `objects` are the animated objects as stable references: Gather's `hashIdentifier` (kept when a space admin publishes a new version of the map, while object ids change), the `CatalogItemVariant` and the position in tiles; `point` (world pixels) is the orbit center or the end point; `period` is in seconds per loop, `direction` 1 (clockwise) or -1, `amplitude` in tiles and `waves` for the wave type. The server adds `id`, `author`, `running` and `startedAt` (ms).

An animated object can also be a custom object of the floor: `{ custom: id, x, y }` (its anchor in tiles when the animation was saved).

A path animation (Fun 1.7.0) is `{ name, type: "path", objects, mode, stagger: { delay, order }, end, steps }`: `mode` is `block` (the selection moves as one piece and turns around its center) or `each` (every object follows the path from its own place); `stagger.delay` (0–60 s) shifts each object's start in `each` mode, in `order` `selection`, `left-right`, `top-bottom` or `random`; `end` is `loop`, `pingpong` or `once`. `steps` (1–20) run one after the other: `{ shape, easing, easingExpr?, duration, pause, rotate }` plus, by `shape`, `line` `{ to }`, `wave` `{ to, amplitude, waves, invert }`, `arc` `{ to, bend }`, `orbit` `{ center, turns, direction }` or `custom` `{ to, x, y }` (tiles added to the straight line). Points are world-pixel offsets from the resting place of the objects' center; `duration` (0.05–600 s) and `pause` (0–600 s, at the arrival) in seconds; `rotate` in degrees over the step; `amplitude` and `bend` in tiles. `easing` is `linear`, `ease-in`, `ease-out`, `ease-in-out`, `sine-in-out`, `back-out`, `bounce-out`, `elastic-out` or `custom` with `easingExpr`; `easingExpr`, `x` and `y` are expressions of `t` (0–1) with numbers, `pi`, `+ - * / ^`, parentheses and `sin cos tan abs sqrt exp floor round sign min max`, only checked token by token here: clients evaluate them with their own parser. Path animations are only listed for mods whose `X-Gather-Mods` header shows Fun 1.7.0 or later (and for `ADMIN_TOKEN`).

Animations belong to a floor (`floorId`), which keeps its id across map versions. They used to be stored per map version with object ids (table `legacy_animations`); clients move them with `/migrate` the first time they open that map version.

### Custom object format

`{ name, imageUrl, opacity, mode, free?, skin? }`: `imageUrl` is an `https` URL (stored normalized: quotes and spaces percent-encoded) or an image of this hub (`/images/:id`); `opacity` 0.1–1. `mode: "skin"` draws the image over a real object, `skin: { object: { hash, variant, x, y } }` (a stable reference, as for animations). `mode: "free"` places it alone, `free: { x, y, width, height, layer, base, collision, anchors? }`: top-left corner and size in tiles (0.25–30), `layer` `floor` (under avatars and objects), `sorted` (in front of what stands above its `base` line, behind what stands below) or `above` (over everything), `base` in tiles from the top of the image, `collision` (the tiles from the base line down block the avatars of mod users), and `anchors`, 1 to 5 real objects spread over the map (stable references): when a new version of the map shifts everything, clients move the image by what most of them moved. The server adds `id` and `author`.

Both modes accept `plane: { relation, object }`: the image is drawn just in `front` of or just `behind` that real object (a stable reference) instead of at its layer's or restyled object's depth.

### Validation and limits

- Names and author: 40 characters max; summary: 300.
- Desks and constructions: 200 objects max, 5 nesting levels, positions within ±100 tiles, area ≤ 50×50.
- Request body: 64 KiB max (refused unread above 256 KB when `Content-Length` says so).
- 20 publication attempts per hour per Gather account (per IP when not signed in).
- Animations: 50 per floor and 10 per Gather account on a floor, 100 objects each, 30 creation attempts per hour per Gather account (per IP when not signed in); period 0.5–600 s, amplitude 0–50 tiles, waves 0.5–50.
- Custom objects: 300 per floor and 30 per Gather account on a floor, 150 creation attempts per hour per Gather account, image URL 500 characters max; uploads: 512 KB max, png/jpeg/gif/webp checked by their first bytes, 20 per hour.
- 30 install reports per hour per Gather account.
- The `deleteToken` and `editToken` are only stored hashed (SHA-256); `ADMIN_TOKEN` is compared in constant time.

A floor holds at most 50 animations (10 per account), checked in the same statement as the insert.

## Storage

One D1 database, `gather-mods-hub`, whose schema lives in `migrations/` (applied by the deploy workflow before each deploy). Writes are visible to every client right away.

| Table               | Rows                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `presets`           | One per shared preset: name, author, summary, lower-case `search` text, `data` (JSON), owner              |
| `animations`        | One per animation, with its `floor_id`; `data` is the animation as clients get it; listed in insert order |
| `legacy_animations` | Animations still stored per map version, until a client migrates them                                     |
| `installs`          | One per mod install: account, launcher, module versions, first and last report                            |
| `announcements`     | Admin announcements; expired ones are not listed                                                          |
| `custom_objects`    | One per custom object, with its `floor_id` and owner; `data` is the object as clients get it              |
| `images`            | Uploaded images (bytes, type, owner)                                                                      |
| `rate_limits`       | Writes per hour, per action and caller; past hours are dropped on the next write                          |

Owned rows have `owner_id` (Gather account) or `token_hash` (created before sign-in); neither is returned. Until October 2026 the hub stored everything in the `PRESETS` KV namespace; `scripts/migrate-kv-to-d1.mjs` copied it into D1.

## Deploy

Every push to `main` that touches `src/`, `migrations/`, `wrangler.toml` or the npm files is deployed by the `Deploy hub` GitHub workflow (`.github/workflows/deploy.yml`), which applies the D1 migrations first; run it by hand from the Actions tab if needed. It needs a `CLOUDFLARE_API_TOKEN` repository secret: a Cloudflare API token from the “Edit Cloudflare Workers” template plus the **D1 Edit** permission, limited to this account.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo Trukl/gather-mod-hub
```

`main` only takes pull requests (ruleset “Protect main”: no direct push, no force push, no deletion), once the `Check` workflow (`.github/workflows/check.yml`) passes: the worker builds (`wrangler deploy --dry-run`), the migrations apply to an empty local D1, and `prettier --check` passes. Since every merge deploys, nothing that doesn't build reaches production.

Deploying from a local checkout still works:

```bash
npm install
npx wrangler login
npm run deploy
```

Deploys never touch the worker's secrets (`SESSION_SECRET`, `ADMIN_TOKEN`).

The D1 database and the mod's `RELEASES` KV namespace (read only, for required updates) are set in `wrangler.toml`. Sessions are signed with a secret:

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Changing it signs everyone out (the mod signs in again on its next request).

### Moderation

```bash
npx wrangler secret put ADMIN_TOKEN
curl -X DELETE -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://gather-mods-hub.minnecorentin.workers.dev/presets/<outfit|desk|construction>/<id>
```

### Usage

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://gather-mods-hub.minnecorentin.workers.dev/stats
```

An install is one Gather client (the desktop app or a browser), identified by a random id the mod keeps in `localStorage`; it is reported again only when its versions change.

### Announcements

Messages to the users of the mod (maintenance, incident, new feature). From Core 1.5.0, the mod checks every 10 minutes: new announcements open one window, and active ones stay at the top of the Mods panel until they expire (`warning` ones in amber).

`--outdated module=x.y.z` sends an announcement only to mods running that module below that version (several pairs, comma-separated: any of them). Post one announcement per feature: a mod sees in the same window the ones it is not up to date for, and they go away once it updates.

```bash
export ADMIN_TOKEN=<ADMIN_TOKEN>
npm run announce -- post "Maintenance tonight" "The hub restarts at 22:00 for about 10 minutes." --warning --hours 3
npm run announce -- list
npm run announce -- delete <id>
npm run announce -- post "New: edit your animations" "Click ✎ next to one of your animations." --outdated fun=1.5.0 --hours 72
```

`HUB_URL=http://localhost:8787` targets a local hub.

## Code

| File                   | Role                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `src/index.js`         | Routes, sign-in requirement, claims                                      |
| `src/auth.js`          | Gather ID token verification and hub sessions                            |
| `src/accounts.js`      | Caller (session, admin, per-item token), ownership, rate limits, sign-in |
| `src/presets.js`       | Presets validation and routes                                            |
| `src/animations.js`    | Animations validation, routes and migration from per-map storage         |
| `src/announcements.js` | Admin announcements                                                      |
| `src/customObjects.js` | Custom objects and image uploads                                         |
| `src/installs.js`      | Install reports and admin stats                                          |
| `src/presence.js`      | Who runs the mod right now, for the marks on the map                     |
| `src/versions.js`      | Required updates: running versions against the published catalog         |
| `src/common.js`        | HTTP helpers (CORS, JSON) and validation primitives                      |
| `migrations/`          | D1 schema                                                                |

## Local development

```bash
npx wrangler d1 migrations apply gather-mods-hub --local   # once, then after each new migration
npm run dev   # http://localhost:8787, local D1 in .wrangler/, secrets in .dev.vars (SESSION_SECRET=...)
```
