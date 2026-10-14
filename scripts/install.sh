#!/usr/bin/env bash
#
# Installs (or updates) ksmail-watcher as a systemd service, on a Raspberry Pi or any Debian-like Linux. Run it from a clone of this repository:
#
#   sudo ./scripts/install.sh                  # Node.js 20 or later already installed
#   sudo ./scripts/install.sh --install-node   # also installs Node.js 22 from nodejs.org
#
# What it does, and nothing else:
#   - a system user "ksmail", with no shell and no password;
#   - the code in /opt/ksmail-watcher (replaced at every run);
#   - the configuration in /etc/ksmail-watcher/config.json, created from config.example.json the first time and NEVER touched afterwards;
#   - the state in /var/lib/ksmail-watcher;
#   - the service unit /etc/systemd/system/ksmail-watcher.service;
#   - a "ksmail-watcher" command in /usr/local/bin that runs the watcher as the service user, with the service's configuration.
#
# Running it again is how you update: the code and the unit are replaced, the configuration and the state are kept, and a running service is restarted.
#
set -euo pipefail

APP_DIR=/opt/ksmail-watcher
CONFIG_DIR=/etc/ksmail-watcher
STATE_DIR=/var/lib/ksmail-watcher
UNIT=/etc/systemd/system/ksmail-watcher.service
WRAPPER=/usr/local/bin/ksmail-watcher
SERVICE_USER=ksmail
NODE_MAJOR_MIN=20
NODE_LINE=22

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_NODE=no

for argument in "$@"; do
    case "$argument" in
        --install-node) INSTALL_NODE=yes ;;
        -h|--help)
            sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $argument (try --help)" >&2; exit 2 ;;
    esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "run it with sudo: sudo $0 $*"
[[ -f "$REPO_DIR/bin/ksmail-watcher.js" ]] || fail "run it from a clone of the ksmail-watcher repository"

# --- Node.js -----------------------------------------------------------

node_major() {
    "$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

install_node() {
    local machine arch base tarball sums
    machine="$(uname -m)"
    case "$machine" in
        aarch64|arm64) arch=arm64 ;;
        armv7l) arch=armv7l ;;
        x86_64|amd64) arch=x64 ;;
        *) fail "no official Node.js build for $machine: install Node.js $NODE_MAJOR_MIN or later yourself" ;;
    esac
    command -v curl >/dev/null || fail "curl is needed to download Node.js (sudo apt install curl)"
    command -v xz >/dev/null || fail "xz is needed to unpack Node.js (sudo apt install xz-utils)"
    base="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
    sums="$(curl -fsSL "$base/SHASUMS256.txt")"
    tarball="$(printf '%s\n' "$sums" | awk -v arch="$arch" '$2 ~ "linux-" arch "\\.tar\\.xz$" { print $2; exit }')"
    [[ -n "$tarball" ]] || fail "could not find the Node.js $NODE_LINE build for linux-$arch"
    say "Downloading $tarball from nodejs.org"
    local scratch
    scratch="$(mktemp -d)"
    trap 'rm -rf "$scratch"' RETURN
    curl -fsSL -o "$scratch/$tarball" "$base/$tarball"
    # The checksum list and the archive come from the same server; this catches a truncated or corrupted download, which is what happens on a Pi on Wi-Fi.
    (cd "$scratch" && printf '%s\n' "$sums" | grep " $tarball\$" | sha256sum -c --quiet -) \
        || fail "the downloaded archive does not match its checksum"
    tar -xJf "$scratch/$tarball" -C /usr/local --strip-components=1
    hash -r
}

NODE="$(command -v node || true)"
if [[ -z "$NODE" || "$(node_major "$NODE")" -lt $NODE_MAJOR_MIN ]]; then
    if [[ $INSTALL_NODE == yes ]]; then
        install_node
        NODE=/usr/local/bin/node
    else
        fail "Node.js $NODE_MAJOR_MIN or later is needed (found: ${NODE:-none}$( [[ -n "$NODE" ]] && echo " v$("$NODE" --version 2>/dev/null)")). Run again with --install-node, or install it yourself."
    fi
fi
say "Using Node.js $("$NODE" --version) at $NODE"

# --- User, code, configuration ------------------------------------------

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    say "Creating the system user $SERVICE_USER"
    useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

say "Installing the code in $APP_DIR"
rm -rf "$APP_DIR.new"
install -d -m 755 "$APP_DIR.new"
for item in bin src package.json LICENSE README.md config.example.json docs; do
    [[ -e "$REPO_DIR/$item" ]] && cp -R "$REPO_DIR/$item" "$APP_DIR.new/"
done
chmod 755 "$APP_DIR.new/bin/ksmail-watcher.js"
rm -rf "$APP_DIR"
mv "$APP_DIR.new" "$APP_DIR"
chown -R root:root "$APP_DIR"

install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR"
FIRST_INSTALL=no
if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
    FIRST_INSTALL=yes
    say "Creating $CONFIG_DIR/config.json from the example"
    sed "s#\"/state/state.json\"#\"$STATE_DIR/state.json\"#" "$REPO_DIR/config.example.json" \
        > "$CONFIG_DIR/config.json"
fi
# It holds mail passwords and the keys of your devices: the service user reads it, nobody else does.
chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/config.json"
chmod 600 "$CONFIG_DIR/config.json"

say "Installing the command $WRAPPER"
cat > "$WRAPPER" <<WRAPPER
#!/bin/sh
# ksmail-watcher, as the service runs it: same user, same configuration. Installed by scripts/install.sh; replaced at every update.
CONFIG="\${KSMAIL_WATCHER_CONFIG:-$CONFIG_DIR/config.json}"
if [ "\$(id -un)" = "$SERVICE_USER" ]; then
    exec env KSMAIL_WATCHER_CONFIG="\$CONFIG" "$NODE" "$APP_DIR/bin/ksmail-watcher.js" "\$@"
fi
exec sudo -u "$SERVICE_USER" env KSMAIL_WATCHER_CONFIG="\$CONFIG" "$NODE" "$APP_DIR/bin/ksmail-watcher.js" "\$@"
WRAPPER
chmod 755 "$WRAPPER"

# --- The service ---------------------------------------------------------

if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    say "No systemd here: the code is installed, start it with: $WRAPPER run"
    exit 0
fi

say "Installing the service $UNIT"
sed -e "s#/usr/bin/node#$NODE#" \
    -e "s#/opt/ksmail-watcher#$APP_DIR#g" \
    "$REPO_DIR/systemd/ksmail-watcher.service" > "$UNIT"
systemctl daemon-reload
systemctl enable ksmail-watcher.service >/dev/null

if grep -q "PASTE" "$CONFIG_DIR/config.json"; then
    cat <<NEXT

The watcher is installed but NOT started: its configuration still holds
the placeholders of the example. Next:

  1. In ksMail, on each device: Settings > Push Notifications >
     Receive Notifications from a Watcher, then Send to the Watcher
     (mail, AirDrop, Messages...) or Copy the Watcher Command.
  2. Here, for each device: ksmail-watcher add-device
     and paste what ksMail sent.
  3. sudo nano $CONFIG_DIR/config.json
     (your mail accounts: the one thing left to type)
  4. ksmail-watcher doctor
  5. sudo systemctl start ksmail-watcher
     journalctl -u ksmail-watcher -f

NEXT
    exit 0
fi

if [[ $FIRST_INSTALL == no ]] && systemctl is-active --quiet ksmail-watcher.service; then
    say "Restarting the service"
    systemctl restart ksmail-watcher.service
else
    say "Starting the service"
    systemctl start ksmail-watcher.service
fi
say "Done. Follow it with: journalctl -u ksmail-watcher -f"
