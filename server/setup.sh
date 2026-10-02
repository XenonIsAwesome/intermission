#!/bin/sh
# Runs on the droplet as root, from deploy.sh: builds odasrv at the pinned
# Odamex commit and (re)starts it as the intermission service. Safe to rerun.
set -eu

COMMIT="$1"
SRC=/opt/intermission-src
APP=/opt/intermission
FREEDOOM=https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
# The same freedoom2.wad the mod ships, or clients can't join
FREEDOOM2_SHA256=a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b

apt-get update -q
apt-get install -yq build-essential cmake git curl unzip zlib1g-dev libzstd-dev

id odamex >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin odamex
install -d -o odamex "$APP"

if [ ! -d "$SRC/.git" ]; then
	git clone https://github.com/odamex/odamex.git "$SRC"
fi
git -C "$SRC" fetch -q origin
git -C "$SRC" checkout -q "$COMMIT"
git -C "$SRC" submodule update -q --init --recursive --depth 1

# Link-time optimisation needs more memory than a 1 GB droplet has
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DUSE_LTO=0 \
	-DBUILD_CLIENT=0 -DBUILD_SERVER=1 -DBUILD_LAUNCHER=0 -DBUILD_TESTS=0 \
	-DUSE_MINIUPNP=0 -DODAMEX_NO_GITVER=1
cmake --build "$SRC/build" -j1

if ! echo "$FREEDOOM2_SHA256  $APP/freedoom2.wad" | sha256sum -c --status 2>/dev/null; then
	curl -fsSL -o /tmp/freedoom.zip "$FREEDOOM"
	unzip -o -q -j /tmp/freedoom.zip '*/freedoom2.wad' -d /tmp
	echo "$FREEDOOM2_SHA256  /tmp/freedoom2.wad" | sha256sum -c --status
	install -m 644 /tmp/freedoom2.wad "$APP/"
fi

install -m 755 "$SRC/build/server/odasrv" "$APP/"
install -m 644 "$SRC/build/server/odamex.wad" /tmp/intermission.cfg "$APP/"
install -m 644 /tmp/intermission.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q intermission
systemctl restart intermission
sleep 2
systemctl --no-pager --lines=8 status intermission
