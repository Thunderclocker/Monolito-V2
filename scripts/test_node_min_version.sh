#!/usr/bin/env bash
set -euo pipefail

version_at_least_22_6() {
  local version="$1"
  local major minor patch extra

  IFS='.' read -r major minor patch extra <<<"${version}"
  if [[ -n "${extra:-}" ]] || [[ ! "${major:-}" =~ ^[0-9]+$ ]] || [[ ! "${minor:-}" =~ ^[0-9]+$ ]] || [[ ! "${patch:-}" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if (( major > 22 )); then
    return 0
  fi
  if (( major < 22 )); then
    return 1
  fi
  (( minor >= 6 ))
}

expect_pass() {
  local version="$1"
  if ! version_at_least_22_6 "${version}"; then
    printf 'expected %s to satisfy >=22.6.0\n' "${version}" >&2
    exit 1
  fi
}

expect_fail() {
  local version="$1"
  if version_at_least_22_6 "${version}"; then
    printf 'expected %s to be rejected by >=22.6.0\n' "${version}" >&2
    exit 1
  fi
}

expect_fail '22.5.0'
expect_pass '22.6.0'
expect_pass '22.11.0'
expect_pass '23.0.0'
expect_fail '21.99.99'
expect_fail '22.6'
expect_fail '22.x.0'

printf 'node minimum version regression: ok\n'
