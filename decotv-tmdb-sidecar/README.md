# decotv-tmdb-sidecar

Standalone TMDB catalog sidecar for DecoTV webOS. Provides a semantic
catalog API that maps to TMDB trending/discover/chart endpoints, plus a
pass-through TMDB image proxy. No auth — LAN only.

## Endpoints

- `GET /api/catalog?action=chart&mediaType=movie&chart=hot` — chart lists
- `GET /api/catalog?action=discover&mediaType=movie&genre=科幻&region=美国&year=2025&sort=S` — filtered discovery
- `GET /api/catalog?action=trending&mediaType=all&window=day` — cross-media trending
- `GET /api/catalog?action=genres&mediaType=movie` — genre list
- `GET /api/image?url=<tmdb image url>` — TMDB image proxy (public, no key)
- `GET /healthz` — health check

## Environment

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TMDB_API_KEY` | yes | — | TMDB v3 API key |
| `PORT` | no | `4001` | listen port |
| `TMDB_PROXY` | no | — | forward proxy URL (for regions where TMDB is blocked) |
| `TMDB_REVERSE_PROXY` | no | — | reverse proxy base (overrides `TMDB_BASE`) |
| `TMDB_BASE` | no | `https://api.themoviedb.org/3` | TMDB API base |
| `TMDB_IMAGE_BASE` | no | `https://image.tmdb.org/t/p` | TMDB image base |
| `TMDB_TIMEOUT_MS` | no | `10000` | upstream timeout |
| `CACHE_TTL_SECONDS` | no | `86400` | in-memory cache TTL |

## Build & push

```bash
docker build -t 192.168.0.110:5000/decotv-tmdb-sidecar:latest .
docker push 192.168.0.110:5000/decotv-tmdb-sidecar:latest
```
