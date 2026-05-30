# Squeezebox Cloud

Squeezebox Cloud is a public and admin web app for a VPS-hosted Squeezebox/Lyrion Music Server setup.

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5177`.

## Backend

- `GET /api/state` returns speaker status, now playing, queue, search defaults, schedules, and admin settings.
- `POST /api/queue` queues a public request.
- `POST /api/player/play`, `/pause`, `/next`, `/previous`, `/volume` call LMS when available and fall back to in-memory state for local development.
- `GET /api/library/search?q=...` scans `MUSIC_SOURCE_DIR`, defaulting to Downloads.
- `GET /api/spotify/status` checks whether Spotify/Spotty appears available through LMS config, favorites, or plugin metadata.

## Tests

```bash
npm test
npm run build
npm run smoke:library
npm run smoke:lms
npm run test:ui
```
