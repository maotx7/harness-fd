#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_NAME="workspace-enterprise"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
PNPM_BIN="$(command -v pnpm || true)"

if [[ -z "$PNPM_BIN" ]]; then
  echo "pnpm is not available on PATH." >&2
  exit 1
fi

if [[ -e "$PROFILE_DIR" || -L "$PROFILE_DIR" ]]; then
  echo "DSH profile already exists: $PROFILE_DIR" >&2
  echo "Remove it explicitly before rebuilding the runtime profile." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
"$PNPM_BIN" exec dsh plugin --profile "$PROFILE_NAME" add \
  '@deepseek-ai/dsh-web-app@0.2.0-rc.2' || true

if [[ ! -d "$PROFILE_DIR/node_modules" ]]; then
  echo "DSH failed to initialize the runtime profile." >&2
  exit 1
fi

sed -i.bak 's/koffi: set this to true or false/koffi: false/' \
  "$PROFILE_DIR/pnpm-workspace.yaml"
rm -f "$PROFILE_DIR/pnpm-workspace.yaml.bak"

"$PNPM_BIN" exec dsh plugin --profile "$PROFILE_NAME" add \
  "$PROJECT_ROOT/packages/workspace/plugin-auth" \
  "$PROJECT_ROOT/packages/workspace/plugin-kb-search" \
  "$PROJECT_ROOT/packages/workspace/plugin-signal-query" \
  "$PROJECT_ROOT/packages/workspace/plugin-workflow-mgmt"

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  const bundles = manifest.dsh.profile.bundles;
  if (!bundles.includes("@deepseek-ai/dsh-web-app")) {
    bundles.push("@deepseek-ai/dsh-web-app");
  }
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$PROFILE_DIR/package.json"

echo "DSH runtime profile installed at $PROFILE_DIR"