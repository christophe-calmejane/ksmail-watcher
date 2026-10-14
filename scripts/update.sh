#!/usr/bin/env bash
#
# Updates an installation made by scripts/install.sh: pulls this clone, then installs again, which replaces the code and the unit, keeps the configuration and the state, and restarts the service.
#
#   ./scripts/update.sh
#
# Read the CHANGELOG first: a release that changes the configuration says so, and the watcher refuses to start until the file is updated.
#
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$REPO_DIR" pull --ff-only
sudo "$REPO_DIR/scripts/install.sh"
