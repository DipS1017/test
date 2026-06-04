#!/usr/bin/env bash
# Stop everything setup.sh started (leaves shared infra: pg/redis/minio/nats).
set -uo pipefail
cd "$(dirname "$0")"
g(){ printf '\033[32m✓\033[0m %s\n' "$*"; }

[ -f .packager.pid ] && kill "$(cat .packager.pid)" 2>/dev/null && g "packager stopped" || true
[ -f .api.pid ] && kill "$(cat .api.pid)" 2>/dev/null && g "API stopped" || true
# belt-and-suspenders by name (in case PIDs drifted)
pkill -f "tmp/worker --packager" 2>/dev/null || true
pkill -f "tmp/api" 2>/dev/null || true
rm -f .api.pid .packager.pid

docker rm -f wepreach-test-mtx >/dev/null 2>&1 && g "test MediaMTX removed" || true
g "done — shared infra (pg/redis/minio/nats) left running"
