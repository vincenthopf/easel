#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 20 or newer is required.' >&2
  exit 1
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  printf '%s\n' "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm is required.' >&2
  exit 1
fi

version=${EASEL_VERSION:-}
if [ -z "$version" ] && [ -f package.json ]; then
  version=$(node -p 'require("./package.json").version')
fi
if [ -z "$version" ]; then
  printf '%s\n' 'Set EASEL_VERSION to the exact Easel release to install.' >&2
  exit 1
fi

if ! node -e 'process.exit(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(process.argv[1]) ? 0 : 1)' "$version"; then
  printf '%s\n' 'EASEL_VERSION must be an exact semantic version such as 0.2.1.' >&2
  exit 1
fi

npm install --global "@vincenthopf/easel@$version"
easel --version
easel init
