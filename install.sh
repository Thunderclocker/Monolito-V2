#!/usr/bin/env bash

set -euo pipefail

MONOLITO_DIR="${HOME}/.monolito"
APP_DIR="${MONOLITO_DIR}/app"
WORKSPACE_DIR="${MONOLITO_DIR}/workspace"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/monolito"
REPO_URL="https://github.com/Thunderclocker/Monolito-V2.git"

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
  # 1. Check curl
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

  # 3. Check build-essential (crucial for better-sqlite3 compilation)
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
  log "Starting Monolito V2 production installation"

  log "Verifying system dependencies..."
  ensure_system_deps

  log "Creating directory layout in ${MONOLITO_DIR}"
  mkdir -p "${MONOLITO_DIR}"
  mkdir -p "${WORKSPACE_DIR}"

  if [ -d "${APP_DIR}" ]; then
    log "Monolito directory already exists in ${APP_DIR}. Updating repository..."
    cd "${APP_DIR}"
    git pull origin main
  else
    log "Cloning Monolito V2 repository into ${APP_DIR}..."
    git clone "${REPO_URL}" "${APP_DIR}"
    cd "${APP_DIR}"
  fi

  log "Installing npm dependencies in ${APP_DIR}"
  npm install

  # Initialize default .env file in ~/.monolito/.env if not present
  if [ ! -f "${MONOLITO_DIR}/.env" ]; then
    log "Creating default configuration in ${MONOLITO_DIR}/.env"
    if [ -f "${APP_DIR}/.env.example" ]; then
      cp "${APP_DIR}/.env.example" "${MONOLITO_DIR}/.env"
    else
      touch "${MONOLITO_DIR}/.env"
    fi
  fi

  log "Installing launcher at ${LAUNCHER_PATH}"
  mkdir -p "${BIN_DIR}"
  cat > "${LAUNCHER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export MONOLITO_MODE=production
cd "${APP_DIR}"
exec node --experimental-strip-types src/apps/cli.ts "\$@"
EOF
  chmod +x "${LAUNCHER_PATH}"

  cat <<EOF

Monolito V2 has been installed successfully in production mode!

Install path:     ${APP_DIR}
Launcher path:    ${LAUNCHER_PATH}
Workspace path:   ${WORKSPACE_DIR}
Config path:      ${MONOLITO_DIR}/.env

Next steps:
  1. Add ${BIN_DIR} to your PATH env var if you haven't already.
  2. Run the CLI:
     monolito
  3. Configure a model profile inside the CLI:
     /model

Enjoy Monolito V2!
EOF
}

main "$@"
