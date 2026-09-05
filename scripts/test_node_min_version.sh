#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="${ROOT_DIR}/install.sh"

# Exercise the implementation that production install.sh actually uses,
# instead of keeping a second copy of the semver predicate in this test.
version_guard="$(sed -n '/^version_at_least_22_6() {/,/^}/p' "${INSTALL_SH}")"
if [[ -z "${version_guard}" ]]; then
  printf 'version_at_least_22_6() not found in install.sh\n' >&2
  exit 1
fi
eval "${version_guard}"

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
expect_fail '22.6.0-rc.1'
expect_fail '22.6.0+build.1'

printf 'installer node minimum version regression: ok\n'
