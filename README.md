# Gather Mod Hub

API du **hub communautaire** du [Gather Mod Menu](https://github.com/Trukl/gather-mod-menu) : stockage et partage des presets de tenues et de bureaux. Worker Cloudflare + KV, déployé sur `https://gather-mods-hub.minnecorentin.workers.dev`.

Seule l'origine `https://app.v2.gather.town` est autorisée en CORS.

## API

| Méthode  | Route                | Rôle                                                                                                  |
| -------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/presets/:type?q=`  | Liste (100 max, plus récents d'abord), avec le preset complet. `q` filtre sur nom, auteur et contenu. |
| `POST`   | `/presets/:type`     | Publie `{ author, data }`. Répond `{ id, type, deleteToken }`.                                        |
| `DELETE` | `/presets/:type/:id` | Supprime, avec `Authorization: Bearer <deleteToken \| ADMIN_TOKEN>`.                                  |

`type` vaut `outfit` ou `desk`.

### Format des presets

- **outfit** : `{ name, outfit: { skin, hair, facialHair, top, jacket, bottom, shoes, hat, glasses, other, costume, mobility }, summary }`. Chaque slot est optionnel et doit être un UUID de wearable Gather.
- **desk** : `{ name, items: [{ variant, name, x, y, children: [...] }], area?: { width, height } }`. `variant` est un UUID de `CatalogItemVariant`, `x`/`y` sont en tuiles, relatifs au coin haut-gauche du bureau (ou à l'objet parent pour `children`).

### Validation et limites

- Noms et auteur : 40 caractères max ; résumé : 300.
- Bureau : 200 objets max, 5 niveaux d'imbrication, positions dans ±100 tuiles, zone ≤ 50×50.
- Corps de requête : 64 Ki max.
- 20 publications par heure et par IP.
- Le `deleteToken` n'est stocké que haché (SHA-256).

La liste repose sur `KV.list` : une publication peut mettre jusqu'à ~60 s à apparaître.

## Déploiement

```bash
npm install
npx wrangler login
npm run deploy
```

Le namespace KV `PRESETS` est fixé dans `wrangler.toml`.

### Modération

```bash
npx wrangler secret put ADMIN_TOKEN
curl -X DELETE -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://gather-mods-hub.minnecorentin.workers.dev/presets/<outfit|desk>/<id>
```

## Développement local

```bash
npm run dev   # http://localhost:8787, KV local dans .wrangler/
```
