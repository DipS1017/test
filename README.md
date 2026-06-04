# Livestream test UI (local, throwaway)

A minimal React app to **see the WePreach livestream flow end-to-end** without curl.
It is intentionally **outside the API repo** so it can never be committed or pushed.

## What it shows (4 panels = the 4 real steps)

1. **Log in** — `POST /api/v1/auth/login` → bearer token (the normal app login).
2. **Create a livestream** — `POST /api/v1/livestreams` → you get a `stream_key` +
   `publish_endpoints`. Note `is_live:false`, `playback_url:null` — **no video yet**.
3. **Go live** — push your **webcam** straight to **MediaMTX** over WHIP (WebRTC),
   or copy the RTMP URL+key into OBS. *This does not call your API.*
4. **Watch** — the panel polls the public detail every 3s; when the **packager**
   detects the publish it flips `is_live:true` and writes HLS to S3, and the
   `live_hls_url` plays here via hls.js.

The key lesson is visible in the timing: step 2 is instant (just a DB row), but
`is_live` only flips a couple seconds into step 3 — because nothing about the
video touches your API. MediaMTX receives it; the packager notices and produces HLS.

## Run

```bash
./setup.sh        # one command: infra + API + packager + dev user + .env.local
npm run dev       # → http://localhost:5173
```

Then in the browser: **Log in → Create → Go live (webcam) → watch is_live flip & video play.**

```bash
./teardown.sh     # stop API/packager + remove the test MediaMTX container
```

## What setup.sh starts

| Thing | Where | Note |
|-------|-------|------|
| MinIO bucket `wepreach` | shared-minio :9000 | public-read so the browser can fetch HLS |
| test MediaMTX | :21935 RTMP / :28889 WHIP / :29997 API | alt ports, alongside any existing mediamtx |
| Go API | :8090 | proxied as `/api` by Vite (no CORS) |
| packager | `worker --packager` | the poller that flips `is_live` + makes HLS |
| dev user + approved channel | Postgres | `streamer@local.test` / `Password123!` |

Requires the shared infra (`shared-pg`, `shared-redis`, `shared-minio`, `shared-nats`)
to already be running, and the API repo's `.env` to have the alt-port `MEDIAMTX_*` /
`*_INGEST_URL` / `ASSET_URL` / `LIVE_INGEST_SECRET=devsecret` values (they already do).

## Gotchas

- **Webcam needs a secure context** — `http://localhost` counts as secure, so it
  works in dev. On a real domain it must be HTTPS.
- If the **WHIP** button errors, your browser may be blocking the webcam, or
  MediaMTX WebRTC ICE can't reach you — fall back to the **OBS** instructions shown
  in panel 3; the rest of the flow is identical.
- Latency is ~6–12s (normal for HLS). The video lags the webcam preview.

## Never commit this
It lives outside the API repo on purpose. Don't move it inside, don't `git add` it.
