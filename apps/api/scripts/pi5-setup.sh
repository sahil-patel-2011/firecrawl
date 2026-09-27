#!/bin/bash
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/sdk/go/bin:$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=2

gzip -t "$HOME/go.tgz"
rm -rf "$HOME/sdk/go"
mkdir -p "$HOME/sdk"
tar -C "$HOME/sdk" -xzf "$HOME/go.tgz"
go version

cd "$HOME/firecrawl-pi/apps/api/sharedLibs/go-html-to-md"
go build -o libhtml-to-markdown.so -buildmode=c-shared html-to-markdown.go
echo SO_OK

if ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"

cd "$HOME/firecrawl-pi/apps/api/native"
pnpm install --ignore-scripts
pnpm build
echo RUST_OK

cd "$HOME/firecrawl-pi/apps/playwright-service-ts"
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install chromium
pnpm run build
echo PW_OK

cd "$HOME/firecrawl-pi/apps/api"
pnpm exec tsc
test -s dist/src/pi5/server.js
echo TSC_OK
