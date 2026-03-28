#!/bin/bash
set -euo pipefail

# Sign and notarize the native bx binary for macOS distribution.
# Usage: pnpm sign
# Requires: Apple Developer ID, xcrun, codesign
#
# Environment variables (or set interactively):
#   APPLE_IDENTITY    — signing identity, e.g. "Developer ID Application: Dirk Holtwick (TEAMID)"
#   APPLE_ID          — Apple ID email for notarization
#   APPLE_TEAM_ID     — Team ID
#   APPLE_APP_PWD     — app-specific password (generate at appleid.apple.com)

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

BINARY="dist/bx-native"

if [ ! -f "${BINARY}" ]; then
  echo "ERROR: ${BINARY} not found. Run 'pnpm build:native' first."
  exit 1
fi

# --- Signing identity ---
IDENTITY="${APPLE_IDENTITY:-}"
if [ -z "${IDENTITY}" ]; then
  echo "Available signing identities:"
  security find-identity -v -p codesigning | grep "Developer ID"
  echo ""
  read -rp "Enter identity (name or hash): " IDENTITY
fi

echo "Signing ${BINARY}..."
codesign --sign "${IDENTITY}" --options runtime --force "${BINARY}"
codesign --verify --verbose "${BINARY}"
echo "Signed successfully."

# --- Notarization ---
APPLE_ID="${APPLE_ID:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_APP_PWD="${APPLE_APP_PWD:-}"

if [ -z "${APPLE_ID}" ] || [ -z "${APPLE_TEAM_ID}" ] || [ -z "${APPLE_APP_PWD}" ]; then
  echo ""
  echo "Skipping notarization (set APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PWD to enable)."
  echo "To notarize manually:"
  echo "  zip dist/bx-native.zip dist/bx-native"
  echo "  xcrun notarytool submit dist/bx-native.zip --apple-id ... --team-id ... --password ..."
  echo "  xcrun stapler staple dist/bx-native"
  exit 0
fi

echo ""
echo "Notarizing..."
ZIP="dist/bx-native.zip"
zip -j "${ZIP}" "${BINARY}"

xcrun notarytool submit "${ZIP}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_APP_PWD}" \
  --wait

xcrun stapler staple "${BINARY}"
rm -f "${ZIP}"

echo ""
echo "Done! ${BINARY} is signed and notarized."
