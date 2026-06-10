#!/usr/bin/env bash

set -euo pipefail

# Paths that are fixed regardless of where the install lives.
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/monolito"
SOCKET_GLOB="/tmp/monolitod-v2-*.sock"
SYSTEMD_UNIT="${HOME}/.config/systemd/user/monolito.service"
ENV_D_FILE="${HOME}/.config/environment.d/monolito.conf"
HOME_STATE_V2="${HOME}/.monolito-v2"
OLLAMA_EMBED_CONTAINER="monolito-v2-ollama-embeddings"
OLLAMA_EMBED_VOLUME="monolito-v2-ollama"

# Paths that depend on ROOT_DIR — initialised by init_paths after detection.
ROOT_DIR=""
STATE_DIR=""
LOCAL_STATE_DIR=""
NODE_MODULES_DIR=""
RUN_DIR=""
PID_FILE=""
LOCK_FILE=""
OWNER_FILE=""
INTENTIONAL_STOP_FLAG=""

REMOVE_REPO=1
ASSUME_YES=0
KEEP_LINGER=0

STT_CONTAINER="monolito-faster-whisper"

SHELL_RC_FILES=(
  "${HOME}/.bashrc"
  "${HOME}/.zshrc"
  "${HOME}/.profile"
  "${HOME}/.bash_profile"
  "${HOME}/.config/fish/config.fish"
)

log() {
  printf '[monolito-uninstall] %s\n' "$1"
}

warn() {
  printf '[monolito-uninstall] WARN: %s\n' "$1" >&2
}

fail() {
  printf '[monolito-uninstall] ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: ./uninstall.sh [--yes] [--keep-repo] [--keep-linger] [--root <path>]

Removes every trace of Monolito V2 from the system:
  - systemd user service and unit file
  - systemd linger (unless --keep-linger)
  - environment.d file
  - shell rc MONOLITO_ROOT / MONOLITO_MODE lines
  - managed Docker containers and the ollama volume
  - state dir (memory, logs, run, workspace, agents)
  - legacy ~/.monolito-v2 state dir if present
  - launcher, sockets, pid/lock/owner files
  - the repo itself (unless --keep-repo)

Options:
  --yes          Skip confirmation prompt.
  --keep-repo    Keep the current repository directory after cleanup.
  --keep-linger  Do not run 'loginctl disable-linger'.
  --root <path>  Force a specific install root (default: auto-detect).
  --help         Show this help.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes|-y)
        ASSUME_YES=1
        ;;
      --keep-repo)
        REMOVE_REPO=0
        ;;
      --keep-linger)
        KEEP_LINGER=1
        ;;
      --root)
        shift
        [[ $# -gt 0 ]] || fail "--root requires a path argument"
        ROOT_DIR="$1"
        ;;
      --root=*)
        ROOT_DIR="${1#--root=}"
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done
}

init_paths() {
  if [[ -z "${ROOT_DIR}" ]]; then
    fail "ROOT_DIR not set; detect_root_dir should have populated it"
  fi
  # STATE_DIR follows ROOT_DIR's parent. The install layout is
  #   ROOT_DIR = ~/.monolito/app
  #   STATE_DIR = ~/.monolito
  STATE_DIR="$(dirname "${ROOT_DIR}")"
  LOCAL_STATE_DIR="${ROOT_DIR}/.monolito-v2"
  NODE_MODULES_DIR="${ROOT_DIR}/node_modules"
  RUN_DIR="${STATE_DIR}/run"
  PID_FILE="${RUN_DIR}/monolitod-v2.pid"
  LOCK_FILE="${RUN_DIR}/daemon-lock.json"
  OWNER_FILE="${RUN_DIR}/daemon-owner.json"
  INTENTIONAL_STOP_FLAG="${RUN_DIR}/intentional-stop.flag"
}

detect_root_dir() {
  # 1. Explicit --root wins.
  if [[ -n "${ROOT_DIR}" ]]; then
    if [[ ! -d "${ROOT_DIR}" ]]; then
      fail "Specified --root does not exist: ${ROOT_DIR}"
    fi
    return 0
  fi

  # 2. The script's own BASH_SOURCE — works for direct invocations.
  local src="${BASH_SOURCE[0]:-}"
  if [[ -n "$src" && "$src" != "bash" && "$src" != "stdin" && -e "$src" ]]; then
    ROOT_DIR="$(cd "$(dirname "$src")" && pwd)"
    return 0
  fi

  # 3. MONOLITO_ROOT env var (if the install honoured it).
  if [[ -n "${MONOLITO_ROOT:-}" && -d "${MONOLITO_ROOT}/src/apps/daemon.ts" ]]; then
    ROOT_DIR="${MONOLITO_ROOT}"
    return 0
  fi

  # 4. Search the default install paths in order.
  for candidate in "${HOME}/.monolito/app" "${HOME}/.monolito-v2" "${HOME}/.monolito"; do
    if [[ -d "${candidate}" && -f "${candidate}/src/apps/daemon.ts" ]]; then
      ROOT_DIR="${candidate}"
      return 0
    fi
  done

  return 1
}

confirm() {
  if (( ASSUME_YES )); then
    return 0
  fi

  printf '%s\n' "This will remove every trace of Monolito V2 from the system:"
  printf '  - %s\n' "${LAUNCHER_PATH}"
  printf '  - %s\n' "${STATE_DIR}"
  printf '  - %s (if present)\n' "${HOME_STATE_V2}"
  printf '  - %s\n' "${LOCAL_STATE_DIR}"
  printf '  - %s\n' "${NODE_MODULES_DIR}"
  printf '  - %s\n' "${SYSTEMD_UNIT}"
  printf '  - %s (if present)\n' "${ENV_D_FILE}"
  printf '  - managed Docker containers: %s, %s, %s\n' \
    "${STT_CONTAINER}" "${OLLAMA_EMBED_CONTAINER}" "any legacy SearXNG (monolito-searxng, searxng/searxng)"
  printf '  - Docker volume: %s\n' "${OLLAMA_EMBED_VOLUME}"
  printf '  - shell rc lines exporting MONOLITO_ROOT or MONOLITO_MODE\n'
  printf '  - %s\n' "${SOCKET_GLOB}"
  if (( REMOVE_REPO )); then
    printf '  - repository %s\n' "${ROOT_DIR}"
  fi
  if (( ! KEEP_LINGER )); then
    printf '  - systemd linger for user %s\n' "${USER}"
  fi
  printf '\nContinue? [y/N] '
  read -r answer
  if [[ ! "${answer}" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    log "Aborted"
    exit 0
  fi
}

is_pid_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-40}"
  local delay_s="${3:-0.25}"
  local i
  for (( i=0; i<attempts; i++ )); do
    if ! is_pid_running "${pid}"; then
      return 0
    fi
    sleep "${delay_s}"
  done
  return 1
}

stop_pid_if_present() {
  local pid="$1"
  local label="$2"
  if ! is_pid_running "${pid}"; then
    return 0
  fi

  log "Stopping ${label} (pid ${pid})"
  kill "${pid}" 2>/dev/null || true
  if wait_for_pid_exit "${pid}"; then
    return 0
  fi

  warn "${label} did not exit after SIGTERM; sending SIGKILL"
  kill -9 "${pid}" 2>/dev/null || true
  wait_for_pid_exit "${pid}" 10 0.2 || warn "${label} still appears to be running"
}

stop_systemd_service() {
  if [[ "$(uname -s)" != "Linux" ]] || ! command -v systemctl >/dev/null 2>&1; then
    log "systemd no detectado; saltando disable del service."
    return 0
  fi

  if [[ -f "${SYSTEMD_UNIT}" ]] || systemctl --user is-enabled monolito.service >/dev/null 2>&1; then
    log "Deshabilitando monolito.service (disable --now)..."
    systemctl --user disable --now monolito.service >/dev/null 2>&1 \
      || warn "systemctl --user disable --now falló (probablemente el service ya estaba caído)."
  else
    log "monolito.service no estaba habilitado, saltando disable."
  fi

  if [[ -f "${ENV_D_FILE}" ]]; then
    log "Removiendo ${ENV_D_FILE}"
    rm -f "${ENV_D_FILE}"
  fi

  if (( KEEP_LINGER )); then
    log "Skipping loginctl disable-linger (--keep-linger)."
  else
    if command -v loginctl >/dev/null 2>&1; then
      local linger_path="/var/lib/systemd/linger/${USER}"
      if [[ -f "${linger_path}" ]] || loginctl show-user "${USER}" 2>/dev/null | grep -q '^Linger=yes'; then
        log "Deshabilitando linger para ${USER}..."
        loginctl disable-linger "${USER}" >/dev/null 2>&1 \
          || warn "loginctl disable-linger falló (puede requerir sudo o no aplica)."
      fi
    fi
  fi

  log "Recargando systemd user daemon..."
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed monolito.service >/dev/null 2>&1 || true
}

stop_monolito_daemon() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(tr -dc '0-9' < "${PID_FILE}")"
    if [[ -n "${pid}" ]]; then
      stop_pid_if_present "${pid}" "Monolito daemon"
    fi
  fi

  local extra_pids
  extra_pids="$(ps -eo pid=,args= | awk -v root="${ROOT_DIR}" '
    index($0, "src/apps/daemon.ts") && index($0, root) {
      print $1
    }
  ')"
  if [[ -n "${extra_pids}" ]]; then
    while read -r pid; do
      [[ -z "${pid}" ]] && continue
      stop_pid_if_present "${pid}" "Monolito daemon"
    done <<< "${extra_pids}"
  fi

  # Also kill any daemon whose cmdline references the legacy root, in case
  # an old zombie is still running.
  local v2_pids
  v2_pids="$(ps -eo pid=,args= | awk -v root="${HOME_STATE_V2}/app" '
    index($0, "src/apps/daemon.ts") && index($0, root) {
      print $1
    }
  ')"
  if [[ -n "${v2_pids}" ]]; then
    while read -r pid; do
      [[ -z "${pid}" ]] && continue
      stop_pid_if_present "${pid}" "Monolito daemon (legacy v2 root)"
    done <<< "${v2_pids}"
  fi
}

remove_if_exists() {
  local target="$1"
  if [[ -e "${target}" || -L "${target}" ]]; then
    log "Removing ${target}"
    rm -rf "${target}"
  fi
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

remove_docker_container_if_present() {
  local name="$1"
  local ids
  ids="$(docker ps -aq --filter "name=^/${name}$" 2>/dev/null || true)"
  if [[ -z "${ids}" ]]; then
    return 0
  fi
  log "Removing Docker container ${name}"
  docker rm -f ${ids} >/dev/null 2>&1 || warn "Failed to remove Docker container ${name}"
}

# Force-remove the cache subtrees the managed containers leave behind as
# root-owned host files. We pass through sudo when available so the
# later plain-`rm` step in cleanup_filesystem_artifacts does not have to
# stop at "Permiso denegado" on the same paths. Best-effort: if sudo
# is not available or fails, we log a warning and let the next step
# pick up whatever it can. The 09-jun-2026 incident: an uninstall
# left ~/.monolito/stt-cache/{huggingface,whisper} populated with
# root:root faster-whisper blobs because the STT container had been
# `docker rm`'d before the user-rm step ran.
remove_root_owned_container_artifacts() {
  # `STATE_DIR` is set by init_paths() which is called in main() before
  # cleanup_docker_artifacts(), so it is safe to reference here. Guard
  # anyway in case init_paths was skipped.
  if [[ -z "${STATE_DIR:-}" ]]; then
    return 0
  fi

  local -a CACHE_SUBDIRS=(
    "${STATE_DIR}/stt-cache"
  )
  local -a SUDO_PREFIX=()
  if command -v sudo >/dev/null 2>&1 && [[ "${EUID}" -ne 0 ]]; then
    SUDO_PREFIX=(sudo)
  fi

  local subdir
  for subdir in "${CACHE_SUBDIRS[@]}"; do
    [[ -e "${subdir}" ]] || continue
    if find "${subdir}" -xdev -not -user "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
      log "Force-removing root-owned container cache at ${subdir}"
      if ! "${SUDO_PREFIX[@]}" rm -rf "${subdir}"; then
        warn "Could not remove ${subdir} (root-owned, sudo unavailable or failed). Run 'sudo rm -rf ${subdir}' manually before reinstalling."
      fi
    fi
  done
}

remove_legacy_docker_matches() {
  local filter="$1"
  local label="$2"
  local ids
  ids="$(docker ps -aq --filter "${filter}" 2>/dev/null || true)"
  if [[ -z "${ids}" ]]; then
    return 0
  fi
  log "Removing ${label}"
  docker rm -f ${ids} >/dev/null 2>&1 || warn "Failed to remove ${label}"
}

remove_docker_volume_if_present() {
  local name="$1"
  if ! docker volume inspect "${name}" >/dev/null 2>&1; then
    return 0
  fi
  log "Removing Docker volume ${name} (~1-2GB of Ollama models will be redownloaded on next install)"
  docker volume rm "${name}" >/dev/null 2>&1 \
    || warn "Failed to remove Docker volume ${name}"
}

cleanup_docker_artifacts() {
  if ! docker_available; then
    log "Docker not available; skipping managed container cleanup"
    return 0
  fi

  remove_docker_container_if_present "${STT_CONTAINER}"
  remove_docker_container_if_present "${OLLAMA_EMBED_CONTAINER}"
  # Legacy SearXNG containers from old installs. The SearXNG backend
  # itself was removed; we still clean up any leftover containers from
  # users on the previous build.
  remove_legacy_docker_matches "name=monolito-searxng" "legacy SearXNG containers"
  remove_legacy_docker_matches "ancestor=searxng/searxng" "legacy SearXNG containers"
  remove_legacy_docker_matches "name=monolito-openai-edge-tts" "legacy managed TTS containers"
  remove_legacy_docker_matches "name=tts-edge" "legacy TTS containers"
  # Container volumes and bind-mounts frequently leave behind host files
  # owned by the container's runtime uid (root in our case). The
  # later `remove_if_exists "${STATE_DIR}"` runs as the invoking user and
  # silently leaves these root-owned files behind — a real-world
  # reinstall loop leaves the same ~/.monolito/stt-cache populated with
  # the previous install's faster-whisper blobs. Force the cleanup
  # here while we still have sudo context. Falls back to plain rm with
  # a warning if sudo is unavailable.
  remove_root_owned_container_artifacts
  remove_legacy_docker_matches "ancestor=travisvn/openai-edge-tts:latest" "legacy OpenAI Edge TTS containers"
  remove_legacy_docker_matches "name=whisper" "legacy Whisper containers"
  remove_legacy_docker_matches "ancestor=onerahmet/openai-whisper-asr-webservice:latest" "legacy Whisper ASR containers"

  remove_docker_volume_if_present "${OLLAMA_EMBED_VOLUME}"
}

# Clean MONOLITO_* lines from shell rc files. Pure standalone lines get
# deleted; lines that mix MONOLITO with other content get commented out so
# we don't break unrelated shell syntax.
cleanup_shell_rc() {
  local file
  for file in "${SHELL_RC_FILES[@]}"; do
    if [[ ! -f "${file}" ]]; then
      continue
    fi
    if ! grep -qE '(^|[[:space:]])(export[[:space:]]+)?MONOLITO_(ROOT|MODE)=' "${file}"; then
      continue
    fi
    log "Limpiando referencias a MONOLITO en ${file}"
    local tmp
    tmp="$(mktemp)"
    local removed=0
    local commented=0
    while IFS= read -r line; do
      local stripped
      stripped="$(printf '%s' "${line}" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//')"
      if [[ "${stripped}" =~ ^MONOLITO_(ROOT|MODE)= ]]; then
        # Standalone MONOLITO line: drop it entirely.
        removed=$((removed + 1))
        continue
      fi
      if [[ "${line}" =~ (^|[[:space:]])(export[[:space:]]+)?MONOLITO_(ROOT|MODE)= ]]; then
        printf '# monolito-uninstall: %s\n' "${line}" >> "${tmp}"
        commented=$((commented + 1))
        continue
      fi
      printf '%s\n' "${line}" >> "${tmp}"
    done < "${file}"
    mv "${tmp}" "${file}"
    log "  ${file}: ${removed} line(s) removed, ${commented} line(s) commented"
  done
}

cleanup_filesystem_artifacts() {
  remove_if_exists "${LAUNCHER_PATH}"
  remove_if_exists "${SYSTEMD_UNIT}"
  remove_if_exists "${ENV_D_FILE}"
  remove_if_exists "${INTENTIONAL_STOP_FLAG}"
  remove_if_exists "${STATE_DIR}"
  remove_if_exists "${HOME_STATE_V2}"
  remove_if_exists "${LOCAL_STATE_DIR}"
  remove_if_exists "${NODE_MODULES_DIR}"
  remove_if_exists "${LOCK_FILE}"
  remove_if_exists "${OWNER_FILE}"
  remove_if_exists "${PID_FILE}"

  shopt -s nullglob
  local sockets=( ${SOCKET_GLOB} )
  shopt -u nullglob
  if (( ${#sockets[@]} > 0 )); then
    for sock in "${sockets[@]}"; do
      remove_if_exists "${sock}"
    done
  fi

  if (( REMOVE_REPO )); then
    local parent_dir
    parent_dir="$(dirname "${ROOT_DIR}")"
    log "Removing repository ${ROOT_DIR}"
    cd "${parent_dir}"
    rm -rf "${ROOT_DIR}"
  fi
}

main() {
  parse_args "$@"
  if ! detect_root_dir; then
    fail "Cannot locate Monolito installation. Use --root <path> if it lives outside ~/.monolito or ~/.monolito-v2."
  fi
  init_paths
  confirm
  stop_systemd_service
  stop_monolito_daemon
  cleanup_docker_artifacts
  cleanup_shell_rc
  cleanup_filesystem_artifacts
  log "Monolito V2 uninstall completed."
}

main "$@"
