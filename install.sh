#!/bin/sh
# Install or upgrade the standalone bstack binary from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/wsehl/bstack/main/install.sh | sh
#
# Set BSTACK_INSTALL_DIR to choose the directory (default: ~/.local/bin).
set -eu

install_dir="${BSTACK_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "error: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no bstack binary for $(uname -s); install with: npm install -g bstack" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no bstack binary for $(uname -m); install with: npm install -g bstack" ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon; prefer the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

url="https://github.com/wsehl/bstack/releases/latest/download/bstack-$os-$arch"
target="$install_dir/bstack"

mkdir -p "$install_dir"

# Download next to the target and rename over it, so a running bstack (for
# example `bstack upgrade`) keeps its old file and never sees a partial one.
tmp="$target.download.$$"
trap 'rm -f "$tmp"' EXIT

echo "Downloading $url"
curl -fsSL "$url" -o "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$target"

echo "Installed bstack $("$target" --version) to $target"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run bstack." ;;
esac
