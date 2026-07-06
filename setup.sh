#!/usr/bin/env bash
#
# easel — one-shot setup for macOS.
# Installs Node.js (if needed), installs easel, then runs the config wizard.
#
# Run it with:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/vincenthopf/easel/main/setup.sh)"
#
set -euo pipefail

PKG="@vincenthopf/easel"
MIN_NODE_MAJOR=20

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
info() { printf "\033[36m›\033[0m %s\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
die()  { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux/Windows, install Node 20+ then: npm install -g $PKG"

bold "Setting up easel"

# ---------------------------------------------------------------- Node.js ---
node_ok=false
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "${major:-0}" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null && node_ok=true
fi

if $node_ok; then
  ok "Node.js $(node -v) is installed"
else
  info "Node.js ${MIN_NODE_MAJOR}+ not found — installing via Homebrew"
  if ! command -v brew >/dev/null 2>&1; then
    info "Installing Homebrew first (you may be asked for your Mac password)…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Make brew available in this session (Apple Silicon, then Intel).
    if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ];   then eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  command -v brew >/dev/null 2>&1 || die "Homebrew isn't available — install it from https://brew.sh then re-run."
  brew install node
  ok "Node.js $(node -v) installed"
fi

command -v npm >/dev/null 2>&1 || die "npm wasn't found after installing Node. Open a new terminal and re-run."

# ------------------------------------------------------------------ easel ---
info "Installing $PKG…"
npm install -g "$PKG"
hash -r 2>/dev/null || true
command -v easel >/dev/null 2>&1 || die "easel installed but isn't on your PATH yet — open a new terminal and re-run."
ok "$(easel --version)"

# -------------------------------------------------------------- configure ---
bold "Let's connect your Canvas"
info "You'll need an access token: Canvas → Account → Settings → New Access Token"
# Read prompts from the terminal even when this script is piped in.
if [ -r /dev/tty ]; then
  easel init < /dev/tty
else
  easel init
fi

bold "All set 🎉"
echo "Try:  easel today"
