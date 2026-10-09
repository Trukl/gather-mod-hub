# Gather Mod Hub

API of the **community hub** of the [Gather Mod Menu](https://github.com/Trukl/gather-mod-menu): stores and shares outfit, desk and construction presets, and the object animations of each map. Cloudflare Worker + KV, deployed at `https://gather-mods-hub.minnecorentin.workers.dev`.

CORS only allows the `https://app.v2.gather.town` origin.

## API

| Method   | Route                    | Purpose                                                                                          |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `GET`    | `/presets/:type?q=`      | List (100 max, newest first), with the full preset. `q` filters on name, author and content.     |
| `POST`   | `/presets/:type`         | Publishes `{ author, data }`. Answers `{ id, type, deleteToken }`.                               |
| `DELETE` | `/presets/:type/:id`     | Deletes, with `Authorization: Bearer <deleteToken \| ADMIN_TOKEN>`.                              |
| `GET`    | `/animations/:mapId`     | Animations of a Gather map, with the server time `now` (clients sync their clock on it).         |
| `POST`   | `/animations/:mapId`     | Creates `{ author, data }`, running. Answers `{ animation, editToken, now }`.                    |
| `PATCH`  | `/animations/:mapId/:id` | `{ running }` starts (from the beginning) or stops it, with `Bearer <editToken \| ADMIN_TOKEN>`. |
| `DELETE` | `/animations/:mapId/:id` | Deletes, with `Bearer <editToken \| ADMIN_TOKEN>`.                                               |

`type` is `outfit`, `desk` or `construction`.

### Preset formats

- **outfit**: `{ name, outfit: { skin, hair, facialHair, top, jacket, bottom, shoes, hat, glasses, other, costume, mobility }, summary }`. Every slot is optional and must be a Gather wearable UUID.
- **desk**: `{ name, items: [{ variant, name, x, y, children: [...] }], area?: { width, height } }`. `variant` is a `CatalogItemVariant` UUID; `x`/`y` are in tiles, relative to the desk's top-left corner (or to the parent object for `children`).
- **construction**: `{ name, items }`, same `items` as `desk`, with `x`/`y` relative to the tile-aligned top-left corner of the group.

### Animation format

`{ name, type, ids, point: { x, y }, params: { period, direction, amplitude, waves } }`: `type` is `orbit`, `line` or `wave`; `ids` are the animated `MapObject` UUIDs; `point` (world pixels) is the orbit center or the end point; `period` is in seconds per loop, `direction` 1 (clockwise) or -1, `amplitude` in tiles and `waves` for the wave type. The server adds `id`, `author`, `running` and `startedAt` (ms).

### Validation and limits

- Names and author: 40 characters max; summary: 300.
- Desks and constructions: 200 objects max, 5 nesting levels, positions within ±100 tiles, area ≤ 50×50.
- Request body: 64 KiB max.
- 20 publications per hour per IP.
- Animations: 50 per map, 100 objects each, 30 created per hour per IP; period 0.5–600 s, amplitude 0–50 tiles, waves 0.5–50.
- The `deleteToken` and `editToken` are only stored hashed (SHA-256).

Listing relies on `KV.list`: a new preset can take up to ~60 s to show up. The animations of a map are a single KV value (one read per listing); other clients can see a change up to ~60 s later.

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

The `PRESETS` KV namespace is set in `wrangler.toml`.

### Moderation

```bash
npx wrangler secret put ADMIN_TOKEN
curl -X DELETE -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://gather-mods-hub.minnecorentin.workers.dev/presets/<outfit|desk|construction>/<id>
```

## Local development

```bash
npm run dev   # http://localhost:8787, local KV in .wrangler/
```
