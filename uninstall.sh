#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${HOME}/.monolito-v2"
LEGACY_STATE_DIR="${HOME}/.monolito"
LOCAL_STATE_DIR="${ROOT_DIR}/.monolito-v2"
NODE_MODULES_DIR="${ROOT_DIR}/node_modules"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/monolito"
RUN_DIR="${STATE_DIR}/run"
PID_FILE="${RUN_DIR}/monolitod-v2.pid"
LOCK_FILE="${RUN_DIR}/daemon-lock.json"
OWNER_FILE="${RUN_DIR}/daemon-owner.json"
SOCKET_GLOB="/tmp/monolitod-v2-*.sock"

REMOVE_REPO=1
ASSUME_YES=0

SEARXNG_CONTAINER="monolito-searxng"
TTS_CONTAINER="monolito-openai-edge-tts"
STT_CONTAINER="monolito-faster-whisper"

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
Usage: ./uninstall.sh [--yes] [--keep-repo]

Removes all Monolito V2 traces: launcher, runtime state, local artifacts, managed Docker services, and this repository directory.

Options:
  --yes        Skip confirmation prompt.
  --keep-repo  Keep the current repository directory after cleanup.
  --help       Show this help.
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

confirm() {
  if (( ASSUME_YES )); then
    return 0
  fi

  printf '%s\n' "This will remove all Monolito traces from:"
  printf '  - %s\n' "${LAUNCHER_PATH}"
  printf '  - %s\n' "${STATE_DIR}"
  printf '  - %s\n' "${LEGACY_STATE_DIR}"
  printf '  - %s\n' "${LOCAL_STATE_DIR}"
  printf '  - %s\n' "${NODE_MODULES_DIR}"
  printf '  - %s\n' "${SOCKET_GLOB}"
  printf '  - %s\n' "${ROOT_DIR}"
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

cleanup_docker_artifacts() {
  if ! docker_available; then
    log "Docker not available; skipping managed container cleanup"
    return 0
  fi

  remove_docker_container_if_present "${SEARXNG_CONTAINER}"
  remove_docker_container_if_present "${TTS_CONTAINER}"
  remove_docker_container_if_present "${STT_CONTAINER}"
  remove_legacy_docker_matches "name=tts-edge" "legacy TTS containers"
  remove_legacy_docker_matches "ancestor=travisvn/openai-edge-tts:latest" "legacy OpenAI Edge TTS containers"
  remove_legacy_docker_matches "name=whisper" "legacy Whisper containers"
  remove_legacy_docker_matches "ancestor=onerahmet/openai-whisper-asr-webservice:latest" "legacy Whisper ASR containers"
}

cleanup_filesystem_artifacts() {
  remove_if_exists "${LAUNCHER_PATH}"
  remove_if_exists "${STATE_DIR}"
  remove_if_exists "${LEGACY_STATE_DIR}"
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
  confirm
  stop_monolito_daemon
  cleanup_docker_artifacts
  cleanup_filesystem_artifacts
  log "Monolito V2 uninstall completed."
}

main "$@"
