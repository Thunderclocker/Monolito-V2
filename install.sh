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

  # 4. Check Node.js and version (Node >= 22 required).
  #
  # IMPORTANT: We intentionally do NOT auto-install Node.js via
  # `curl ... | sudo bash` (e.g. NodeSource's setup_22.x script). The Monolito
  # runtime blocks `curl | bash` patterns in agent-generated skill guides
  # because they are an arbitrary-code-execution vector if the upstream
  # endpoint is ever compromised. Auto-installing the same way for our own
  # installer would be inconsistent and expose users to the same risk.
  #
  # Instead, we require Node.js 22+ as a prerequisite (already documented in
  # the README) and fail with concrete install instructions if missing.
  local node_ok=true
  if ! command -v node >/dev/null 2>&1; then
    node_ok=false
  elif ! command -v npm >/dev/null 2>&1; then
    node_ok=false
  else
    local node_major
    node_major="$(parse_node_major)"
    if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
      node_ok=false
    fi
  fi

  if [ "$node_ok" = false ]; then
    cat <<'NODE_HELP' >&2

[monolito-install] Node.js 22+ is required but was not found.

Recommended install options (choose one):

  • Official binary tarball (verifiable SHA256):
      curl -fsSLO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
      curl -fsSLO https://nodejs.org/dist/v22.11.0/SHASUMS256.txt
      grep node-v22.11.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum -c -
      tar -xJf node-v22.11.0-linux-x64.tar.xz -C /usr/local --strip-components=1
      (or into ~/.local for a user-local install)

  • nvm (Node Version Manager):
      https://github.com/nvm-sh/nvm#installing-and-updating
      nvm install 22 && nvm use 22

  • Your distribution's package manager (apt/dnf/brew/etc):
      e.g. on Debian/Ubuntu: see https://nodejs.org/en/download/package-manager/

Re-run this installer after installing Node.js 22+.
NODE_HELP
    fail "Node.js 22+ is required. See the instructions above."
  fi
}

stop_existing_daemon() {
  # Best-effort: if a previous monolito.service is running, stop it cleanly
  # before we re-install. Without this, the old daemon keeps running with
  # stale code while we re-write the unit, which leads to a confusing state
  # where 'is-active' returns true for the OLD binary.
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if systemctl --user is-active monolito.service >/dev/null 2>&1; then
    log "Deteniendo monolito.service previo antes de reinstalar..."
    systemctl --user stop monolito.service 2>&1 | sed 's/^/  /' || true
    # Give it a moment to flush and release the SQLite WAL
    sleep 2
  fi
}

enable_and_start_service() {
  if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
    log "systemd no detectado; el daemon no se auto-arrancará al boot. Iniciálo manualmente con 'monolito'."
    return 0
  fi

  # --- 1. enable-linger (REQUIRED for autostart without login) ---
  # Without linger, user services only run while the user is logged in.
  # On a headless server or after a reboot where the user hasn't logged
  # in yet, the daemon would never start. This command typically needs
  # to run as root (or with sudo). If it fails, the install CANNOT
  # guarantee autostart, so we abort with a clear fix.
  log "Habilitando linger para el usuario ${USER}..."
  if ! loginctl enable-linger "${USER}" 2>&1 | sed 's/^/  /'; then
    if [[ "$EUID" -ne 0 ]]; then
      fail "loginctl enable-linger falló. Sin esto, el daemon NO va a auto-arrancar al boot.
Solución: re-ejecutá el install con sudo, o corré 'sudo loginctl enable-linger ${USER}' manualmente."
    else
      fail "loginctl enable-linger falló por un motivo desconocido. Revisá: journalctl -u systemd-logind"
    fi
  fi

  # --- 2. Materialize systemd unit ---
  log "Materializando unit de systemd con MONOLITO_ROOT hardcodeado..."
  if ! node --experimental-strip-types src/apps/daemon.ts --write-unit-only 2>&1 | sed 's/^/  /'; then
    fail "no se pudo materializar el unit file. Abortando para evitar dejar systemd en estado roto."
  fi

  # --- 3. daemon-reload ---
  log "Recargando systemd..."
  if ! systemctl --user daemon-reload 2>&1 | sed 's/^/  /'; then
    fail "systemctl --user daemon-reload falló. El unit no se puede activar."
  fi

  # --- 4. enable --now (idempotent) ---
  log "Habilitando monolito.service (enable --now)..."
  if ! systemctl --user enable --now monolito.service 2>&1 | sed 's/^/  /'; then
    fail "systemctl --user enable --now monolito.service falló.
El service no quedó habilitado. Solución:
  systemctl --user enable --now monolito.service
y revisá el error con 'journalctl --user -u monolito.service'."
  fi

  # --- 5. Wait for active state (give the binary time to bind socket) ---
  local waited=0
  while [ "${waited}" -lt 15 ] && ! systemctl --user is-active monolito.service >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
  done

  # --- 6. Post-install validation: all three must be true ---
  # We don't trust 'is-active' alone; we also verify 'is-enabled' and
  # 'Linger=yes' so a half-broken install is reported as a failure.
  local all_good=true
  if ! systemctl --user is-active monolito.service >/dev/null 2>&1; then
    log "ERROR: el service no quedó 'active' tras 15s. Estado actual:"
    systemctl --user status monolito.service --no-pager 2>&1 | sed 's/^/  /' || true
    all_good=false
  fi
  if ! systemctl --user is-enabled monolito.service >/dev/null 2>&1; then
    log "ERROR: el service no quedó 'enabled'. No va a auto-arrancar al boot."
    all_good=false
  fi
  if ! loginctl show-user "${USER}" 2>/dev/null | grep -q "Linger=yes"; then
    log "ERROR: el usuario ${USER} no tiene Linger=yes. El daemon NO va a arrancar al boot sin login."
    all_good=false
  fi

  if [ "$all_good" = false ]; then
    fail "la instalación del autostart de systemd falló. El install continúa pero vas a tener que diagnosticar. Revisar: journalctl --user -u monolito.service -n 50"
  fi

  log "Daemon corriendo bajo systemd (autostart al boot)."
}

main() {
  log "Starting Monolito V2 production installation"

  log "Verifying system dependencies..."
  ensure_system_deps

  log "Creating directory layout in ${MONOLITO_DIR}"
  mkdir -p "${MONOLITO_DIR}"
  mkdir -p "${WORKSPACE_DIR}"
  # Pre-create the runtime subdirs the daemon needs to write to BEFORE
  # systemd tries to open stdout/stderr log files. Otherwise the unit
  # fails with 'Failed to set up standard output: No such file or
  # directory' on first start.
  mkdir -p "${MONOLITO_DIR}/memory" "${MONOLITO_DIR}/logs" "${MONOLITO_DIR}/logs/instances" "${MONOLITO_DIR}/run" "${MONOLITO_DIR}/agents" "${WORKSPACE_DIR}/scratchpad"

  # Stop the previous daemon BEFORE we touch files. This is critical for
  # re-installs: the old daemon is holding the SQLite database open and
  # the unit file in memory. If we re-materialize the unit while it's
  # still running, the old daemon keeps using the OLD code in memory
  # until the next restart, which is exactly the "I rebooted and the
  # daemon is missing" failure mode.
  stop_existing_daemon

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

  log "Writing install pin at ${MONOLITO_DIR}/.install-root"
  printf "%s\n" "${MONOLITO_DIR}" > "${MONOLITO_DIR}/.install-root"

  if [ -n "${MONOLITO_ROOT:-}" ] && [ "${MONOLITO_ROOT}" != "${MONOLITO_DIR}" ]; then
    log "WARN: MONOLITO_ROOT está exportado en tu shell (${MONOLITO_ROOT}); el daemon ignorará ese valor y usará el pin."
  fi

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

  enable_and_start_service
  # enable_and_start_service now uses 'fail' (exit 1) on any error, so
  # we should never reach here if it broke. But we keep this defensive
  # check so that a future regression in the function doesn't silently
  # claim "Install path: ${APP_DIR}" success at the end.
  local service_status
  service_status="$(systemctl --user is-active monolito.service 2>/dev/null || echo 'inactive')"
  if [ "$service_status" != "active" ]; then
    log "WARN: el service terminó en estado '$service_status'. Investigar: journalctl --user -u monolito.service -n 50"
  fi

  cat <<EOF

Monolito V2 has been installed successfully in production mode!

Install path:     ${APP_DIR}
Launcher path:    ${LAUNCHER_PATH}
Workspace path:   ${WORKSPACE_DIR}
Config path:      ${MONOLITO_DIR}/.env

Next steps:
  1. Add ${BIN_DIR} to your PATH env var if you haven't already.
  2. The daemon is managed by systemd and will auto-start on every login.
     Run 'monolito' any time to open the TUI. To stop the daemon for
     good, use 'monolito /stop' (it will stay down until you run 'monolito'
     again) or './uninstall.sh' to remove everything.
  3. Configure a model profile inside the CLI:
     /model

Enjoy Monolito V2!
EOF
}

main "$@"
