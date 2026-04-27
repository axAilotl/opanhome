#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_env="$project_root/.env"
example_env="$project_root/.env.example"
hermes_home="${HERMES_HOME_OVERRIDE:-$HOME/.hermes}"
hermes_repo="${HERMES_REPO_OVERRIDE:-$hermes_home/hermes-agent}"
hermes_python="$hermes_repo/venv/bin/python"
hermes_env="$hermes_home/.env"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp

  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print key "=" value
      }
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

[[ -d "$project_root" ]] || fail "project root not found: $project_root"
[[ -d "$hermes_home" ]] || fail "global Hermes home not found: $hermes_home"
[[ -d "$hermes_repo" ]] || fail "Hermes repo not found: $hermes_repo"
[[ -x "$hermes_python" ]] || fail "Hermes venv python not found: $hermes_python"
[[ -f "$hermes_env" ]] || fail "global Hermes env not found: $hermes_env"
[[ -f "$example_env" ]] || fail "missing example env: $example_env"

"$hermes_python" - <<'PY'
from gateway.run import GatewayRunner
from hermes_cli.runtime_provider import resolve_runtime_provider

assert GatewayRunner
assert resolve_runtime_provider
print("Hermes gateway/runtime imports OK")
PY

if [[ ! -f "$project_env" ]]; then
  cp "$example_env" "$project_env"
fi

upsert_env "$project_env" "HERMES_AGENT_BACKEND" "gateway"
upsert_env "$project_env" "HERMES_GATEWAY_HOME" "$hermes_home"
upsert_env "$project_env" "HERMES_HOME" "$hermes_home"
upsert_env "$project_env" "AGENT_RUNTIME" "hermes"
upsert_env "$project_env" "HERMES_API_BASE_URL" "${HERMES_API_BASE_URL:-http://127.0.0.1:8642/v1}"

cat <<EOF
Global Hermes bridge bootstrap complete.

Project env: $project_env
Hermes home: $hermes_home
Hermes repo: $hermes_repo

This repo will now use:
- $hermes_env as the shared Hermes/provider env baseline
- $project_env for bridge-specific overrides like ESPHome host and audio settings

Next:
1. Set ESPHOME_HOST and any device-specific values in $project_env
2. Override DEEPGRAM_API_KEY or ELEVENLABS_API_KEY in $project_env only if you do not want to use the values from $hermes_env
3. Enable API_SERVER_ENABLED=true in $hermes_env and start: hermes gateway
4. Run the TS hub: npm run hub:ts
EOF
