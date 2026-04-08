#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_NAME="$(basename "${ROOT_DIR}")"
STATE_DIR="${HOME}/.monolito-v2"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/monolito"

log() {
  printf '[monolito-install] %s\n' "$1"
}

fail() {
  printf '[monolito-install] ERROR: %s\n' "$1" >&2
  exit 1
}

require_bin() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || fail "Missing required command: ${bin}"
}

parse_node_major() {
  node -p "process.versions.node.split('.')[0]"
}

main() {
  log "Starting Monolito V2 installation"

  if [[ -d "${ROOT_DIR}/${ROOT_NAME}/.git" ]]; then
    fail "Detected a nested git clone at ${ROOT_DIR}/${ROOT_NAME}. Remove or move that duplicate directory before installing."
  fi

  require_bin node
  require_bin npm

  local node_major
  node_major="$(parse_node_major)"
  if [[ ! "$node_major" =~ ^[0-9]+$ ]]; then
    fail "Could not detect Node.js version"
  fi
  if (( node_major < 22 )); then
    fail "Node.js 22 or newer is required. Detected: $(node --version)"
  fi

  log "Installing npm dependencies in ${ROOT_DIR}"
  cd "${ROOT_DIR}"
  npm install

  log "Creating local state directory at ${STATE_DIR}"
  mkdir -p "${STATE_DIR}"

  log "Installing launcher at ${LAUNCHER_PATH}"
  mkdir -p "${BIN_DIR}"
  cat > "${LAUNCHER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${ROOT_DIR}"
exec node --experimental-strip-types src/apps/cli.ts "\$@"
EOF
  chmod +x "${LAUNCHER_PATH}"

  cat <<EOF

Monolito V2 installed successfully.

Next steps:
  1. Run the CLI:
     monolito

  2. Configure a model profile from the CLI:
     /model

Notes:
  - The CLI starts the daemon automatically when needed.
  - Runtime state inside the repo is created under .monolito-v2/ on first run.
  - Global model/channel settings are stored under ${STATE_DIR}/
  - If "monolito" is not found, add ${BIN_DIR} to your PATH.
EOF
}

main "$@"
