#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_ENV="$PROJECT_ROOT/.env"
PROFILE_NAME="workspace-enterprise"
PROFILE_SOURCE="$PROJECT_ROOT/profiles/$PROFILE_NAME"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
PNPM_BIN="$(command -v pnpm || true)"

if [[ -z "$PNPM_BIN" ]]; then
  echo "pnpm is not available on PATH." >&2
  exit 1
fi

if [[ ! -d "$PROFILE_DIR/node_modules" ]]; then
  echo "DSH runtime profile is not installed: $PROFILE_DIR" >&2
  echo "Create the profile and install its dependencies before starting." >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/scripts/merge-profile-patch.mjs" ]]; then
  echo "DSH profile merge script is missing." >&2
  exit 1
fi

for config_file in cordis.yml cordis.schema.json; do
  cp "$PROFILE_SOURCE/$config_file" "$PROFILE_DIR/$config_file"
done
node "$PROJECT_ROOT/scripts/merge-profile-patch.mjs" \
  "$PROFILE_SOURCE/cordis.patch.yml" \
  "$PROFILE_DIR/cordis.patch.yml"

if [[ ! -r "$ROOT_ENV" ]]; then
  echo "Project environment not found: $ROOT_ENV" >&2
  echo "Copy .env.example to .env and fill in the required values." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ROOT_ENV"
set +a

for name in MYSQL_URL JWT_SECRET SIGNATURE_SECRET USER_DATA_ROOT EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_MODEL EMBEDDING_DIMENSION DEEPSEEK_API_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is missing from $ROOT_ENV" >&2
    exit 1
  fi
done

cd "$PROJECT_ROOT"
node "$PROJECT_ROOT/scripts/migrate-runtime-databases.mjs"
exec "$PNPM_BIN" exec dsh --profile "$PROFILE_NAME" "$@"
