#!/bin/sh
# Builds a compressed disk image (.dmg) from "AI Testing Runner.app". Runs only on macOS: it needs hdiutil.
#
#   sh scripts/make-dmg.sh "dist/installer/mac/AI Testing Runner.app" dist/installer/mac/AI-Testing-Runner.dmg
#
# Not run or tested on this project's build machine (Windows). It is the standard hdiutil call and nothing else.
# The image holds the app only. The runner files (runner.mjs, runner.json, runner.token, ...) come from a runner kit downloaded from the
# platform, so an app opened from the image asks you to choose the unzipped kit folder. The app is unsigned: see
# docs/features/runner-installer-mac.md for signing and notarizing.

if [ "$(uname -s)" != "Darwin" ]; then
    echo "make-dmg.sh needs macOS (hdiutil). It was not run." >&2
    exit 1
fi
APP=${1:-}
OUT=${2:-}
if [ -z "$APP" ] || [ -z "$OUT" ] || [ ! -d "$APP" ]; then
    echo "Usage: sh scripts/make-dmg.sh <path to AI Testing Runner.app> <output .dmg>" >&2
    exit 1
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/aitp-dmg.XXXXXX") || exit 1
cp -R "$APP" "$STAGE/" || exit 1
hdiutil create -volname "AI Testing Runner" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
STATUS=$?
rm -rf "$STAGE"
exit "$STATUS"
