#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file instead: source ./activate-hermes.sh" >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
local_home="$project_root/.agents/hermes"

if [[ ! -x "$project_root/hermes" ]]; then
  echo "Local Hermes wrapper not found at $project_root/hermes" >&2
  return 1
fi

case ":$PATH:" in
  *":$project_root:"*) ;;
  *) export PATH="$project_root:$PATH" ;;
esac

mkdir -p "$local_home" "$project_root/.agents/skills"
export HERMES_HOME="$local_home"
export HERMES_GATEWAY_HOME="$local_home"

hash -r 2>/dev/null || true

printf 'Project Hermes activated for %s\n' "$project_root"
printf 'HERMES_HOME=%s\n' "$HERMES_HOME"
printf 'hermes -> %s\n' "$(command -v hermes)"
