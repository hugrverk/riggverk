#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

echo "==> pre-manifest upgrade contract (isolated temp HOME)"
cargo test managed_reconciliation_contract --quiet

echo "==> pre-manifest upgrade smoke passed"
