#!/usr/bin/env bash
#
# Removes the ksmail-watcher service installed by scripts/install.sh.
#
#   sudo ./scripts/uninstall.sh           # keeps the configuration and the state
#   sudo ./scripts/uninstall.sh --purge   # also deletes them, and the user
#
# The configuration holds your mail passwords and your devices' keys: --purge is what you want before giving the machine away. Node.js is left installed either way.
#
set -euo pipefail

PURGE=no
for argument in "$@"; do
    case "$argument" in
        --purge) PURGE=yes ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $argument (try --help)" >&2; exit 2 ;;
    esac
done
[[ $EUID -eq 0 ]] || { echo "run it with sudo" >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable --now ksmail-watcher.service 2>/dev/null || true
    rm -f /etc/systemd/system/ksmail-watcher.service
    systemctl daemon-reload
fi
rm -rf /opt/ksmail-watcher
rm -f /usr/local/bin/ksmail-watcher

if [[ $PURGE == yes ]]; then
    rm -rf /etc/ksmail-watcher /var/lib/ksmail-watcher
    id ksmail >/dev/null 2>&1 && userdel ksmail
    echo "ksmail-watcher removed, with its configuration, its state and its user."
else
    echo "ksmail-watcher removed. Kept: /etc/ksmail-watcher (configuration) and /var/lib/ksmail-watcher (state)."
fi
