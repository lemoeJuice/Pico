#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  printf 'Usage: %s [bind-address]\n' "$0" >&2
  exit 2
fi

if (( $# == 1 )); then
  if [[ -z "$1" ]]; then
    printf 'Bind address must not be empty.\n' >&2
    exit 2
  fi
  export PICO_HOST="$1"
fi

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

exec npm start
