#!/bin/sh
# Install or update the OpenWetter publisher on an Ubuntu server (run as root).
# Expects ./icon-rs (x86_64 Linux build) next to this script, built with:
#   RUSTUP_TOOLCHAIN=1.99.1 cargo zigbuild --release --target x86_64-unknown-linux-gnu.2.35
# R2 credentials go in /etc/openwetter/r2.env (see r2.env.example); never commit them.
set -eu
cd "$(dirname "$0")"
id openwetter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin openwetter
install -d -m 0755 /opt/openwetter/bin
install -m 0755 icon-rs /opt/openwetter/bin/icon-rs
install -d -m 0750 -o root -g openwetter /etc/openwetter
install -m 0644 openwetter-publish.service openwetter-publish.timer openwetter-live.service openwetter-live.timer /etc/systemd/system/
systemctl daemon-reload
if [ -f /etc/openwetter/r2.env ]; then
  systemctl enable --now openwetter-publish.timer openwetter-live.timer
  echo "timers enabled"
else
  echo "add /etc/openwetter/r2.env, then: systemctl enable --now openwetter-publish.timer openwetter-live.timer"
fi
