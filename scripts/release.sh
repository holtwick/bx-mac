#!/bin/bash
set -euo pipefail

# Release bx: build, tag, create GitHub release, update Homebrew formula
# Usage: pnpm release
# Requires: gh (GitHub CLI)

VERSION=$(node -e "console.log(require('./package.json').version)")
TAG="v${VERSION}"

echo "Releasing bx ${TAG}..."

# Build
pnpm build

# Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit changes first."
  exit 1
fi

# Tag and push (skip if tag already exists)
git tag "${TAG}" 2>/dev/null || echo "Tag ${TAG} already exists, reusing it."
git push origin "${TAG}" 2>/dev/null || true

# Create GitHub release with bx.js attached
gh release create "${TAG}" dist/bx.js \
  --title "${TAG}" \
  --generate-notes

# Publish to npm
npm publish --access public

# Update Homebrew formula
SHA=$(shasum -a 256 dist/bx.js | awk '{print $1}')

TAP_DIR=$(brew --repository holtwick/tap 2>/dev/null || echo "")
if [ -z "${TAP_DIR}" ] || [ ! -d "${TAP_DIR}" ]; then
  echo ""
  echo "Homebrew tap not found. Run: brew tap holtwick/tap"
  echo "Then update Formula/bx.rb manually:"
  echo "  url: https://github.com/holtwick/bx-mac/releases/download/${TAG}/bx.js"
  echo "  sha256: ${SHA}"
  exit 0
fi

mkdir -p "${TAP_DIR}/Formula"
cat > "${TAP_DIR}/Formula/bx.rb" << FORMULA
class Bx < Formula
  desc "Launch apps in a macOS sandbox — only the project directory is accessible"
  homepage "https://github.com/holtwick/bx-mac"
  url "https://github.com/holtwick/bx-mac/releases/download/${TAG}/bx.js"
  sha256 "${SHA}"
  version "${VERSION}"
  license "MIT"

  depends_on "node"
  depends_on :macos

  def install
    bin.install "bx.js" => "bx"
  end

  test do
    assert_match "sandbox:", shell_output("#{bin}/bx 2>&1", 1)
  end
end
FORMULA

cd "${TAP_DIR}"
git add Formula/bx.rb
git commit -m "bx ${VERSION}"
git push

echo ""
echo "Done! Released bx ${TAG}"
echo "  GitHub: https://github.com/holtwick/bx-mac/releases/tag/${TAG}"
echo "  Homebrew: brew install holtwick/tap/bx"
