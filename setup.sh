#!/usr/bin/env bash
# ============================================================
# setup.sh — bring up everything the test UI needs, locally.
# Idempotent: safe to re-run. Tears down with ./teardown.sh
# ============================================================
# Starts: MinIO bucket, a test MediaMTX (alt ports), the Go API (:8090),
# the live packager. Creates+verifies a dev user + approved channel, then
# writes .env.local so the React app is pre-wired.
set -euo pipefail
cd "$(dirname "$0")"

API_DIR="/home/dips/webpoint/we-preach-love-api"
DEV_EMAIL="streamer@local.test"
DEV_PASS="Password123!"
SECRET="devsecret"
PG="docker exec shared-pg psql -U postgres -d wepreach -tAc"

g(){ printf '\033[32m✓\033[0m %s\n' "$*"; }
i(){ printf '\033[36m▶\033[0m %s\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker required"
[ -d "$API_DIR" ] || die "API repo not found at $API_DIR"
docker ps --format '{{.Names}}' | grep -q '^shared-pg$'    || die "shared-pg not running"
docker ps --format '{{.Names}}' | grep -q '^shared-minio$' || die "shared-minio not running"

# 1. MinIO bucket + public read ------------------------------------------------
i "MinIO bucket 'wepreach' (+ public read)…"
docker run --rm --network container:shared-minio --entrypoint sh minio/mc -c \
  "mc alias set L http://localhost:9000 minioadmin minioadmin >/dev/null 2>&1 && mc mb -p L/wepreach >/dev/null 2>&1; mc anonymous set download L/wepreach >/dev/null 2>&1" || true
g "bucket ready"

# 2. test MediaMTX on alt ports (alongside any existing mediamtx) --------------
i "test MediaMTX (RTMP 21935 / WHIP 28889 / API 29997)…"
docker rm -f wepreach-test-mtx >/dev/null 2>&1 || true
docker run -d --name wepreach-test-mtx \
  --add-host host.docker.internal:host-gateway \
  -p 21935:1935 -p 28554:8554 -p 28888:8888 -p 28889:8889 -p 28890:8890/udp -p 29997:9997 \
  -e MTX_AUTHHTTPADDRESS="http://host.docker.internal:8090/internal/live/auth?secret=${SECRET}" \
  -e MTX_PATHDEFAULTS_RECORD=no \
  -e MTX_WEBRTCADDITIONALHOSTS=127.0.0.1 \
  -v "$API_DIR/mediamtx.yml:/mediamtx.yml:ro" \
  bluenviron/mediamtx:latest >/dev/null
sleep 2
curl -fsS --max-time 4 http://localhost:29997/v3/paths/list >/dev/null || die "MediaMTX control API not reachable"
g "MediaMTX up"

# 3. build + start API and packager -------------------------------------------
i "building API + worker…"
( cd "$API_DIR" && go build -o tmp/api ./cmd/wepreach && go build -o tmp/worker ./cmd/worker )
g "built"

if curl -fsS --max-time 3 http://localhost:8090/api/v1/public/healthz >/dev/null 2>&1; then
  g "API already running on :8090"
else
  i "starting API (:8090)…"
  ( cd "$API_DIR" && PORT=8090 nohup ./tmp/api >tmp/ui-api.log 2>&1 & echo $! >"$OLDPWD/.api.pid" )
  for n in $(seq 1 30); do
    curl -fsS --max-time 2 http://localhost:8090/api/v1/public/healthz >/dev/null 2>&1 && break
    sleep 1; [ "$n" = 30 ] && { tail -20 "$API_DIR/tmp/ui-api.log"; die "API didn't become healthy"; }
  done
  g "API up (log: $API_DIR/tmp/ui-api.log)"
fi

i "starting packager…"
pkill -f "tmp/worker --packager" >/dev/null 2>&1 || true
( cd "$API_DIR" && nohup ./tmp/worker --packager >tmp/ui-packager.log 2>&1 & echo $! >"$OLDPWD/.packager.pid" )
sleep 2
g "packager up (log: $API_DIR/tmp/ui-packager.log)"

# 4. dev user (signup via API → verify in DB) ---------------------------------
i "ensuring dev user ${DEV_EMAIL}…"
curl -fsS -X POST http://localhost:8090/api/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Local Streamer\",\"email\":\"${DEV_EMAIL}\",\"password\":\"${DEV_PASS}\",\"privacy_policy\":true,\"is_regulation_accepted\":true}" \
  >/dev/null 2>&1 || true   # already exists → fine
$PG "UPDATE users SET is_email_verified=true, status='ACTIVE' WHERE email='${DEV_EMAIL}';" >/dev/null
USER_ID=$($PG "SELECT id FROM users WHERE email='${DEV_EMAIL}';" | tr -d '[:space:]')
[ -n "$USER_ID" ] || die "could not create/find dev user"
g "dev user ${USER_ID}"

# 5. approved channel ----------------------------------------------------------
# uuid() strips any stray psql command tag (e.g. "INSERT 0 1") and keeps the UUID.
uuid(){ grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
CHANNEL_ID=$($PG "SELECT id FROM channels WHERE owner_id='${USER_ID}' AND status!='rejected' ORDER BY created_at DESC LIMIT 1;" | uuid)
if [ -z "$CHANNEL_ID" ]; then
  CHANNEL_ID=$($PG "INSERT INTO channels (owner_id,name,status) VALUES ('${USER_ID}','Local Test Channel','approved') RETURNING id;" | uuid)
else
  $PG "UPDATE channels SET status='approved' WHERE id='${CHANNEL_ID}';" >/dev/null
fi
[ -n "$CHANNEL_ID" ] || die "could not get/create approved channel"
g "approved channel ${CHANNEL_ID}"

# 6. write .env.local for the React app ---------------------------------------
cat > .env.local <<EOF
VITE_CHANNEL_ID=${CHANNEL_ID}
VITE_DEV_EMAIL=${DEV_EMAIL}
VITE_DEV_PASSWORD=${DEV_PASS}
EOF
g "wrote .env.local"

# 7. npm deps ------------------------------------------------------------------
if [ ! -d node_modules ]; then
  i "npm install…"; npm install --silent
fi
g "deps ready"

echo
g "ALL SET. Now run:  npm run dev   → open http://localhost:5173"
echo "   API:      http://localhost:8090   (log: $API_DIR/tmp/ui-api.log)"
echo "   Packager: log $API_DIR/tmp/ui-packager.log"
echo "   Stop everything:  ./teardown.sh"
