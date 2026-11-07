#!/bin/sh
# Builds a compressed disk image (.dmg) holding "AI Testing Runner.app" and, when it has been built, the installer package. Runs only on
# macOS: it needs hdiutil.
#
#   sh scripts/make-dmg.sh "dist/installer/mac/AI Testing Runner.app" dist/installer/mac/AI-Testing-Runner.dmg
#   sh scripts/make-dmg.sh --out DIR [--app PATH]     the image goes to DIR/AI-Testing-Runner.dmg, with DIR/AI-Testing-Runner.pkg in it
#                                                     when that exists (sh scripts/build-runner-pkg.sh --out DIR)
#
# Run in CI on macOS (.github/workflows/runner-matrix.yml, ai-studio-deploy.yml); not by hand on a real Mac yet. The image holds no
# runner download: the runner files and the one-time code come from a download made on the platform's Runners page, so an app opened
# from the image asks you to choose the unzipped download. Signing and notarising: docs/features/runner-installer-mac.md.

if [ "$(uname -s)" != "Darwin" ]; then
    echo "make-dmg.sh needs macOS (hdiutil). It was not run." >&2
    exit 1
fi
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=""
OUT=""
DIR=""
if [ "${1:-}" = "--out" ] || [ "${1:-}" = "--app" ]; then
    while [ $# -gt 0 ]; do
        case "$1" in
            --out) DIR=${2:-} ; shift ;;
            --app) APP=${2:-} ; shift ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
        shift
    done
    APP=${APP:-"$HERE/dist/installer/mac/AI Testing Runner.app"}
    [ -n "$DIR" ] || { echo "--out needs a folder." >&2; exit 1; }
    mkdir -p "$DIR" || exit 1
    OUT="$DIR/AI-Testing-Runner.dmg"
else
    APP=${1:-}
    OUT=${2:-}
fi
if [ -z "$APP" ] || [ -z "$OUT" ] || [ ! -d "$APP" ]; then
    echo "Usage: sh scripts/make-dmg.sh <path to AI Testing Runner.app> <output .dmg>   or   sh scripts/make-dmg.sh --out DIR [--app PATH]" >&2
    exit 1
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/aitp-dmg.XXXXXX") || exit 1
ditto "$APP" "$STAGE/$(basename "$APP")" || exit 1
if [ -n "$DIR" ] && [ -f "$DIR/AI-Testing-Runner.pkg" ]; then
    cp "$DIR/AI-Testing-Runner.pkg" "$STAGE/" || exit 1
fi
hdiutil create -volname "AI Testing Runner" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
STATUS=$?
rm -rf "$STAGE"
exit "$STATUS"
