#!/bin/sh
# Install or update the OpenWetter publisher on an Ubuntu server (run as root, from this folder).
# The binary comes from the public GitHub release "publisher" (built by GitHub Actions from
# tools/icon-rs on main); afterwards openwetter-update.timer installs every new build by itself.
# A local ./icon-rs next to this script, if present, is installed instead (testing a build).
# R2 credentials go in /etc/openwetter/r2.env (see r2.env.example); never commit them.
set -eu
cd "$(dirname "$0")"
id openwetter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin openwetter
# The updater runs as openwetter, so the binary folder belongs to it.
install -d -m 0755 -o openwetter -g openwetter /opt/openwetter/bin
install -m 0755 -o openwetter -g openwetter openwetter-update.sh /opt/openwetter/bin/openwetter-update.sh
install -d -m 0755 -o openwetter -g openwetter /var/lib/openwetter
install -d -m 0750 -o root -g openwetter /etc/openwetter
if [ -f icon-rs ]; then
  install -m 0755 -o openwetter -g openwetter icon-rs /opt/openwetter/bin/icon-rs
else
  runuser -u openwetter -- /usr/bin/flock -w 1800 /var/lib/openwetter/publish.lock /opt/openwetter/bin/openwetter-update.sh
fi
/opt/openwetter/bin/icon-rs --version
install -m 0644 openwetter-publish.service openwetter-publish.timer openwetter-publish-eu.service openwetter-publish-eu.timer \
  openwetter-publish-global.service openwetter-publish-global.timer openwetter-live.service openwetter-live.timer \
  openwetter-update.service openwetter-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openwetter-update.timer
if [ -f /etc/openwetter/r2.env ]; then
  systemctl enable --now openwetter-publish.timer openwetter-publish-eu.timer openwetter-publish-global.timer openwetter-live.timer
  echo "timers enabled"
else
  echo "add /etc/openwetter/r2.env, then: systemctl enable --now openwetter-publish.timer openwetter-publish-eu.timer openwetter-publish-global.timer openwetter-live.timer"
fi
