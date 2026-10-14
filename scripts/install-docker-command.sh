#!/usr/bin/env bash
#
# Gives a watcher run with Docker Compose the same "ksmail-watcher" command as a systemd install, so that the line ksMail shares works as it is:
#
#   sudo ./scripts/install-docker-command.sh            # from the clone that docker compose runs
#   sudo ./scripts/install-docker-command.sh --remove   # takes the command away again
#
# What it does, and nothing else:
#   - creates config/config.json from config.example.json if there is none yet, and the state folder;
#   - gives both to uid 1000, the user the container runs as, with the configuration readable by it alone (chmod 600);
#   - installs /usr/local/bin/ksmail-watcher, which runs each command (add-device, doctor, test-push, oauth) in a throwaway container of the watcher's image, with this clone's configuration folder mounted writable.
#
# The service itself keeps running with "docker compose up -d", and keeps its configuration read only.
# Run this again after moving the clone: the command names the folder it was installed from.
#
set -euo pipefail

WRAPPER=/usr/local/bin/ksmail-watcher
MARKER="installed by scripts/install-docker-command.sh"
CONTAINER_UID=1000

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOVE=no

for argument in "$@"; do
    case "$argument" in
        --remove) REMOVE=yes ;;
        -h|--help)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $argument (try --help)" >&2; exit 2 ;;
    esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "run it with sudo: sudo $0 $*"

# A command of the systemd install is not ours to replace: two installs would be two watchers on the same mailboxes.
if [[ -e "$WRAPPER" ]] && ! grep -q "$MARKER" "$WRAPPER"; then
    fail "$WRAPPER is the command of a systemd install (scripts/install.sh): use one install or the other, not both"
fi

if [[ $REMOVE == yes ]]; then
    rm -f "$WRAPPER"
    say "Removed $WRAPPER. The configuration and the state are where they were."
    exit 0
fi

[[ -f "$REPO_DIR/docker-compose.yml" ]] || fail "run it from a clone of the ksmail-watcher repository"
[[ "$REPO_DIR" != *"'"* ]] || fail "the path of this clone holds a quote ($REPO_DIR): move it somewhere plainer"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is not installed (docker compose version fails)"

# --- The configuration and the state, owned by the container's user -----

mkdir -p "$REPO_DIR/config" "$REPO_DIR/state"
if [[ ! -f "$REPO_DIR/config/config.json" ]]; then
    say "Creating config/config.json from the example"
    cp "$REPO_DIR/config.example.json" "$REPO_DIR/config/config.json"
fi
say "Giving config/ and state/ to uid $CONTAINER_UID, the user the container runs as"
chown -R "$CONTAINER_UID:$CONTAINER_UID" "$REPO_DIR/config" "$REPO_DIR/state"
chmod 700 "$REPO_DIR/config"
chmod 600 "$REPO_DIR/config/config.json"

# --- The command ----------------------------------------------------------

say "Installing the command $WRAPPER"
cat > "$WRAPPER" <<WRAPPER
#!/bin/sh
# ksmail-watcher, for the watcher Docker Compose runs in $REPO_DIR: $MARKER (--remove takes it away).
# Each command runs in a throwaway container of the watcher's image, with the configuration folder mounted writable at /edit, so that add-device can write it.
# The service itself only ever mounts it read only.
set -e
if [ "\$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
    exec sudo "\$0" "\$@"
fi
case "\${1:-run}" in
    run)
        echo "The service runs with Docker Compose: cd '$REPO_DIR' && docker compose up -d" >&2
        exit 2
        ;;
esac
cd '$REPO_DIR'
exec docker compose run --rm -v '$REPO_DIR/config:/edit' ksmail-watcher "\$@" --config /edit/config.json
WRAPPER
chmod 755 "$WRAPPER"

cat <<NEXT

Done. The same commands as a systemd install now work here:

  ksmail-watcher add-device       paste the line ksMail shared, once per device
  ksmail-watcher doctor           checks the broker, every device and every mailbox
  ksmail-watcher test-push        a notification that looks like a real one
  ksmail-watcher oauth --account <id> --manual

Your mail accounts: sudo nano $REPO_DIR/config/config.json
Then: cd $REPO_DIR && docker compose up -d   (docker compose restart after a change)

NEXT
