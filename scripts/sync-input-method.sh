#!/bin/sh
# Re-vendor the third-party input method component from upstream.
#
#   components/InputMethod/  ->  src/components/InputMethod/
#
# The component is vendored (not a submodule) because aiot-toolkit only packs
# files under src/, and Vela's file API needs a real in-package path for the
# dictionaries (/components/InputMethod/assets/dictionary/).
#
# Usage: sh scripts/sync-input-method.sh [git-ref]
#   default ref is the commit pinned below, so builds stay reproducible.
set -eu

PINNED_REF="b6afb1108d710e62d1e98a0466f26e1fa5e0faf4"
REF="${1:-$PINNED_REF}"
REPO="https://github.com/NEORUAA/Vela_input_method.git"
WORK="$(mktemp -d)"
DEST="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/src/components/InputMethod"

echo "==> cloning $REPO at $REF"
git clone --quiet "$REPO" "$WORK/upstream"
git -C "$WORK/upstream" checkout --quiet "$REF"

echo "==> copying components/InputMethod"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$WORK/upstream/components/InputMethod" "$DEST"
cp "$WORK/upstream/LICENSE" "$DEST/LICENSE"
git -C "$WORK/upstream" log -1 --format='%H %ad' --date=short > "$DEST/UPSTREAM_VERSION"

echo "==> vendored $(git -C "$WORK/upstream" log -1 --format='%h %ad' --date=short)"
rm -rf "$WORK"
echo "done: $DEST"
