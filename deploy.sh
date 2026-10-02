#!/bin/sh
# Builds and (re)starts the intermission game server on the droplet.
# Usage: ./deploy.sh [user@host]
set -eu
cd "$(dirname "$0")"

HOST="${1:-root@157.245.140.115}"

scp -q server/intermission.cfg server/intermission.service "$HOST:/tmp/"
ssh "$HOST" sh -s "$(cat engine/odamex-commit)" < server/setup.sh
