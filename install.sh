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

parse_node_major() {
  node -p "process.versions.node.split('.')[0]"
}

APT_UPDATED=false

install_apt() {
  local pkg="$1"
  log "Installing system package '${pkg}'..."
  if [ "$APT_UPDATED" = false ]; then
    log "Running apt-get update first..."
    if [[ "$EUID" -ne 0 ]]; then
      sudo apt-get update -y
    else
      apt-get update -y
    fi
    APT_UPDATED=true
  fi

  if [[ "$EUID" -ne 0 ]]; then
    sudo apt-get install -y "$pkg"
  else
    apt-get install -y "$pkg"
  fi
}

ensure_system_deps() {
  # 1. Check curl (needed for NodeSource script)
  if ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      install_apt curl
    else
      fail "curl is missing. Please install it on your system."
    fi
  fi

  # 2. Check git
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      install_apt git
    else
      fail "git is missing. Please install it on your system."
    fi
  fi

  # 3. Check build-essential (crucial for native compilations like better-sqlite3)
  if ! dpkg -s build-essential >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      install_apt build-essential
    else
      log "WARNING: build-essential not detected. Native SQLite compilation might fail if not installed."
    fi
  fi

  # 4. Check Node.js and version (Node >= 22 required)
  local install_node=false
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    install_node=true
  else
    local node_major
    node_major="$(parse_node_major)"
    if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
      install_node=true
    fi
  fi

  if [ "$install_node" = true ]; then
    if command -v apt-get >/dev/null 2>&1; then
      log "Installing/upgrading to Node.js 22 via NodeSource..."
      if [[ "$EUID" -ne 0 ]]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      else
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
      fi
    else
      fail "Node.js 22 or newer is required, but we could not auto-install it. Please install Node.js 22+ manually."
    fi
  fi
}

main() {
  log "Starting Monolito V2 installation"

  if [[ -d "${ROOT_DIR}/${ROOT_NAME}/.git" ]]; then
    fail "Detected a nested git clone at ${ROOT_DIR}/${ROOT_NAME}. Remove or move that duplicate directory before installing."
  fi

  log "Verifying system dependencies..."
  ensure_system_deps

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
