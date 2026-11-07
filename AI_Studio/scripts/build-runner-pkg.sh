#!/bin/sh
# Builds a macOS installer package (.pkg) of "AI Testing Runner.app". macOS only: it needs pkgbuild and productbuild.
#
#   sh scripts/build-runner-pkg.sh [--app PATH] [--out DIR] [--sign-app "Developer ID Application: Name (TEAMID)"]
#
#   --app       the app to package (default: dist/installer/mac/AI Testing Runner.app, from node scripts/build-installer.mjs --skip-windows)
#   --out       where AI-Testing-Runner.pkg goes (default: dist/installer-pkg)
#   --sign-app  sign the app with this Developer ID Application identity first (codesign, hardened runtime, secure time stamp). The
#               package itself is signed afterwards with productsign and notarised with notarytool (the deploy workflow does both when
#               its Apple secrets are set; see docs/features/runner-installer-mac.md).
#
# The package installs the app into /Applications, or into ~/Applications when the person chooses "Install for me only" (the
# distribution allows both). It holds the app only: no runner download, no code, no credential, and no script runs while it installs.
# The person then opens the app and chooses the unzipped runner download, which holds the one-time code.
#
# Run in CI on macOS (.github/workflows/runner-matrix.yml and ai-studio-deploy.yml). Not run on a real Mac by the person who wrote it,
# and the platform keeps serving the zip until a pass on a real Mac is green.

APP=""
OUT=""
SIGN_APP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --app | --out | --sign-app)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "The option $1 needs a value." >&2
                exit 2
            fi
            case "$1" in
                --app) APP=$2 ;;
                --out) OUT=$2 ;;
                --sign-app) SIGN_APP=$2 ;;
            esac
            shift
            ;;
        -h | --help)
            sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$(uname -s)" != "Darwin" ] || ! command -v pkgbuild >/dev/null 2>&1 || ! command -v productbuild >/dev/null 2>&1; then
    echo "build-runner-pkg.sh needs macOS (pkgbuild and productbuild). It was not run." >&2
    exit 1
fi
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=${APP:-"$HERE/dist/installer/mac/AI Testing Runner.app"}
OUT=${OUT:-"$HERE/dist/installer-pkg"}
if [ ! -d "$APP/Contents" ]; then
    echo "There is no app at $APP. Build it first: node scripts/build-installer.mjs --skip-windows" >&2
    exit 1
fi
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null)
VERSION=${VERSION:-1.0.0}
mkdir -p "$OUT" || exit 1
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/aitp-pkg.XXXXXX") || exit 1
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/root" || exit 1
# ditto keeps modes and the app's extended attributes (a signature of a script lives there).
ditto "$APP" "$STAGE/root/AI Testing Runner.app" || exit 1
xattr -dr com.apple.quarantine "$STAGE/root/AI Testing Runner.app" 2>/dev/null

if [ -n "$SIGN_APP" ]; then
    codesign --force --deep --options runtime --timestamp --sign "$SIGN_APP" "$STAGE/root/AI Testing Runner.app" || exit 1
    codesign --verify --deep --strict "$STAGE/root/AI Testing Runner.app" || exit 1
fi

# Installed exactly where the package says: never moved to wherever another copy of the app happens to be.
pkgbuild --analyze --root "$STAGE/root" "$STAGE/component.plist" >/dev/null || exit 1
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$STAGE/component.plist" || exit 1
pkgbuild --root "$STAGE/root" --component-plist "$STAGE/component.plist" --identifier app.aitesting.runner.app --version "$VERSION" --install-location /Applications "$STAGE/AITestingRunnerApp.pkg" || exit 1

cat >"$STAGE/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>AI Testing Runner</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="11.0"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="app"/>
    </choices-outline>
    <choice id="app" visible="false">
        <pkg-ref id="app.aitesting.runner.app"/>
    </choice>
    <pkg-ref id="app.aitesting.runner.app" version="$VERSION" onConclusion="none">AITestingRunnerApp.pkg</pkg-ref>
</installer-gui-script>
XML

productbuild --distribution "$STAGE/distribution.xml" --package-path "$STAGE" --version "$VERSION" "$OUT/AI-Testing-Runner.pkg" || exit 1
echo "Built $OUT/AI-Testing-Runner.pkg (version $VERSION${SIGN_APP:+, app signed})."
