#!/bin/sh
# Run the unit and API integration tests on a desktop Node (>= 18).
#
#   sh tests/run.sh
#
# The watch runtime is not involved. api.js is executed unmodified; only its
# module specifiers are rewritten so Node can resolve them:
#   '@system.fetch'  -> ./fetch-double.mjs   (Vela API stand-in)
#   './base64'       -> ./base64.mjs         (Node ESM needs an extension)
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD="$ROOT/tests/.build"
NODE=${NODE:-node}

if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "tests need Node >= 18 (global fetch), found $("$NODE" -v)" >&2
  exit 1
fi

rm -rf "$BUILD"
mkdir -p "$BUILD"

sed -e "s#from '@system.fetch'#from './fetch-double.mjs'#" \
    -e "s#from './base64'#from './base64.mjs'#" \
    "$ROOT/src/common/scripts/api.js" > "$BUILD/api.mjs"
sed -e "s#from '@system.storage'#from './storage-double.mjs'#" \
    "$ROOT/src/common/scripts/store.js" > "$BUILD/store.mjs"
cp "$ROOT/src/common/scripts/base64.js" "$BUILD/base64.mjs"
cp "$ROOT/src/common/scripts/format.js" "$BUILD/format.mjs"
cp "$ROOT/src/common/scripts/protocol.js" "$BUILD/protocol.mjs"
cp "$ROOT/tests/fetch-double.mjs" "$BUILD/fetch-double.mjs"
cp "$ROOT/tests/storage-double.mjs" "$BUILD/storage-double.mjs"

fail=0
"$NODE" "$ROOT/tests/units.test.mjs" || fail=1
"$NODE" "$ROOT/tests/store.test.mjs" || fail=1
"$NODE" "$ROOT/tests/protocol.test.mjs" || fail=1
"$NODE" "$ROOT/tests/setup.test.mjs" || fail=1
"$NODE" "$ROOT/tests/chat.test.mjs" || fail=1
"$NODE" "$ROOT/tests/api.test.mjs" || fail=1
"$NODE" "$ROOT/tests/seed-watch-chat.test.mjs" || fail=1

if [ "$fail" -eq 0 ]; then
  rm -rf "$BUILD"
  echo
  echo "all tests passed"
else
  echo >&2
  echo "tests failed, build dir kept at $BUILD" >&2
fi

exit "$fail"
