# Gather Mod Hub

API of the **community hub** of the [Gather Mod Menu](https://github.com/Trukl/gather-mod-menu): stores and shares outfit, desk and construction presets, and the object animations of each map. Cloudflare Worker + KV, deployed at `https://gather-mods-hub.minnecorentin.workers.dev`.

CORS only allows the `https://app.v2.gather.town` origin.

## Sign-in with the Gather account

The mod reads Gather's Firebase ID token from the page and sends it to `POST /auth`. The hub checks its signature against Google's public keys, its issuer (`securetoken.google.com/gather-town-v2`), audience and expiry, keeps only the Gather account id (`gather.userAccountId`, never the token nor the email) and answers a hub session valid 30 days, signed with `SESSION_SECRET`. Requests then send `Authorization: Bearer <session>`.

Presets and animations created with a session belong to that Gather account (`ownerId`, never returned): every client of that account can delete or start/stop them, and lists flag them with `mine: true`. Items created before sign-in keep their `deleteToken`/`editToken` until `POST /auth/claim` hands them to the account.

From 2026-10-20 16:30 UTC (`SIGN_IN_REQUIRED_FROM`), every route but `POST /auth` requires a session (or `ADMIN_TOKEN`): requests without one get `401 sign in required`, so only people signed in to Gather with the mod can read or publish. Until then, mods that don't sign in yet (before Community hub 1.1.0 / Fun 1.3.0) are still served.

## Required updates

From Core 1.4.0, the mod sends the versions of its running modules with every request, in the `X-Gather-Mods` header (`core=1.4.0,hub-api=1.3.0,…`). The hub reads the published catalog of the mod (key `catalog:latest` of the release worker's `RELEASES` KV namespace, cached 5 minutes): a changelog entry marked `"breaking": true` is the minimum version of its module. When a running module is below it, every route but `POST /installs` answers `426 { error: "update required", modules: [{ id, changelog: [breaking entries it misses] }] }`, and the mod opens its “Update required” window. Requests without the header (mods before Core 1.4.0) are not checked.

## API

| Method   | Route                          | Purpose                                                                                                                                                                                                                                                       |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth`                        | `{ gatherToken }` → `{ session, expiresAt }`.                                                                                                                                                                                                                 |
| `POST`   | `/auth/claim`                  | With a session: `{ presets: [{ type, id, token }], animations: [{ floorId, id, token }] }` → `{ claimed: [ids] }`.                                                                                                                                            |
| `GET`    | `/presets/:type?q=`            | List (100 max, newest first), with the full preset and `mine`. `q` filters on name, author and content.                                                                                                                                                       |
| `POST`   | `/presets/:type`               | Publishes `{ author, data }`. Answers `{ id, type }` (plus `deleteToken` when not signed in).                                                                                                                                                                 |
| `DELETE` | `/presets/:type/:id`           | Deletes, with `Bearer <owner's session \| deleteToken \| ADMIN_TOKEN>`.                                                                                                                                                                                       |
| `GET`    | `/animations/:floorId?map=`    | Animations of a Gather floor with `mine`, and the server time `now` (clients sync their clock on it). With `map`, also `legacy`: the animations still stored for that map version.                                                                            |
| `POST`   | `/animations/:floorId`         | Creates `{ author, data }`, running. Answers `{ animation, now }` (plus `editToken` when not signed in).                                                                                                                                                      |
| `POST`   | `/animations/:floorId/migrate` | With a session: `{ mapId, items: [{ id, objects }] }` moves that map version's legacy animations to the floor with the given object references (the others are dropped). Answers `{ now, items }`.                                                            |
| `PATCH`  | `/animations/:floorId/:id`     | `{ running }` starts (from the beginning) or stops it, with `Bearer <owner's session \| editToken \| ADMIN_TOKEN>`.                                                                                                                                           |
| `DELETE` | `/animations/:floorId/:id`     | Deletes, with `Bearer <owner's session \| editToken \| ADMIN_TOKEN>`.                                                                                                                                                                                         |
| `POST`   | `/installs`                    | `{ gatherToken, installId, launcher, versions: { core: "1.3.0", … } }`: the mod's core reports its installed module versions on first install and after each update. The Gather token is verified like `/auth`; only the account id is kept, with the report. |
| `GET`    | `/stats`                       | With `ADMIN_TOKEN`: `{ installs, accounts, launcher, updatedLast30Days, modules: { id: { version: count } }, items }`.                                                                                                                                        |
| `GET`    | `/announcements`               | Active announcements, without session: `{ announcements: [{ id, title, message, level, createdAt, expiresAt }] }`.                                                                                                                                            |
| `POST`   | `/announcements`               | With `ADMIN_TOKEN`: `{ title, message, level: "info" \| "warning", hours }` (title 60 and message 500 characters max, 24 hours by default, 30 days max). Answers `{ announcement }`.                                                                          |
| `DELETE` | `/announcements/:id`           | With `ADMIN_TOKEN`: removes it before it expires.                                                                                                                                                                                                             |

`type` is `outfit`, `desk` or `construction`.

### Preset formats

- **outfit**: `{ name, outfit: { skin, hair, facialHair, top, jacket, bottom, shoes, hat, glasses, other, costume, mobility }, summary }`. Every slot is optional and must be a Gather wearable UUID.
- **desk**: `{ name, items: [{ variant, name, x, y, children: [...] }], area?: { width, height } }`. `variant` is a `CatalogItemVariant` UUID; `x`/`y` are in tiles, relative to the desk's top-left corner (or to the parent object for `children`).
- **construction**: `{ name, items }`, same `items` as `desk`, with `x`/`y` relative to the tile-aligned top-left corner of the group.

### Animation format

`{ name, type, objects: [{ hash, variant, x, y }], point: { x, y }, params: { period, direction, amplitude, waves } }`: `type` is `orbit`, `line` or `wave`; `objects` are the animated objects as stable references: Gather's `hashIdentifier` (kept when a space admin publishes a new version of the map, while object ids change), the `CatalogItemVariant` and the position in tiles; `point` (world pixels) is the orbit center or the end point; `period` is in seconds per loop, `direction` 1 (clockwise) or -1, `amplitude` in tiles and `waves` for the wave type. The server adds `id`, `author`, `running` and `startedAt` (ms).

Animations belong to a floor (`floorId`), which keeps its id across map versions. They used to be stored per map version with object ids (`a:<mapId>` keys); clients move them with `/migrate` the first time they open that map version.

### Validation and limits

- Names and author: 40 characters max; summary: 300.
- Desks and constructions: 200 objects max, 5 nesting levels, positions within ±100 tiles, area ≤ 50×50.
- Request body: 64 KiB max.
- 20 publication attempts per hour per Gather account (per IP when not signed in).
- Animations: 50 per floor, 100 objects each, 30 creation attempts per hour per Gather account (per IP when not signed in); period 0.5–600 s, amplitude 0–50 tiles, waves 0.5–50.
- 30 install reports per hour per Gather account.
- The `deleteToken` and `editToken` are only stored hashed (SHA-256).

Listing relies on `KV.list`: a new preset can take up to ~60 s to show up. The animations of a floor are a single KV value (one read per listing); other clients can see a change up to ~60 s later.

## Deploy

Every push to `main` that touches `src/`, `wrangler.toml` or the npm files is deployed by the `Deploy hub` GitHub workflow (`.github/workflows/deploy.yml`); run it by hand from the Actions tab if needed. It needs a `CLOUDFLARE_API_TOKEN` repository secret: a Cloudflare API token from the “Edit Cloudflare Workers” template, limited to this account.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo Trukl/gather-mod-hub
```

Deploying from a local checkout still works:

```bash
npm install
npx wrangler login
npm run deploy
```

Deploys never touch the worker's secrets (`SESSION_SECRET`, `ADMIN_TOKEN`).

The `PRESETS` KV namespace and the mod's `RELEASES` namespace (read only, for required updates) are set in `wrangler.toml`. Sessions are signed with a secret:

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

Messages to every user of the mod (maintenance, incident, new feature). From Core 1.5.0, the mod checks every 10 minutes: a new announcement opens a window once, and active ones stay at the top of the Mods panel until they expire (`warning` ones in amber).

```bash
export ADMIN_TOKEN=<ADMIN_TOKEN>
npm run announce -- post "Maintenance tonight" "The hub restarts at 22:00 for about 10 minutes." --warning --hours 3
npm run announce -- list
npm run announce -- delete <id>
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
| `src/installs.js`      | Install reports and admin stats                                          |
| `src/versions.js`      | Required updates: running versions against the published catalog         |
| `src/common.js`        | HTTP helpers (CORS, JSON) and validation primitives                      |

## Local development

```bash
npm run dev   # http://localhost:8787, local KV in .wrangler/, secrets in .dev.vars (SESSION_SECRET=...)
```
