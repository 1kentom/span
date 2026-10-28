#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
installer="$script_dir/install-cli.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export HOME="$fixture/home"
export PATH=/usr/bin:/bin
mkdir -p "$HOME" "$fixture/native app"
target="$fixture/native app/span-desktop"
printf '#!/bin/sh\nexit 0\n' > "$target"
chmod +x "$target"
bash "$installer" --target "$target" --dry-run > "$fixture/dry-run"
[ ! -d "$HOME/.local" ]
# Verify fallback PATH guidance without relying on optional shell tools.
case "$(cat "$fixture/dry-run")" in *'Add this directory to PATH'*) ;; *) exit 1;; esac
bash "$installer" --target "$target" --prefix "$fixture/custom prefix" > "$fixture/install"
[ "$(readlink "$fixture/custom prefix/bin/span")" = "$target" ]
bash "$installer" --target "$target" --prefix "$fixture/custom prefix" > /dev/null
mkdir -p "$fixture/conflict/bin"
printf 'unrelated command\n' > "$fixture/conflict/bin/span"
if bash "$installer" --target "$target" --prefix "$fixture/conflict" > /dev/null 2>&1; then exit 1; fi
[ "$(cat "$fixture/conflict/bin/span")" = 'unrelated command' ]
mkdir -p "$fixture/link-conflict/bin"
ln -s /missing/other-command "$fixture/link-conflict/bin/span"
if bash "$installer" --target "$target" --prefix "$fixture/link-conflict" > /dev/null 2>&1; then exit 1; fi
[ "$(readlink "$fixture/link-conflict/bin/span")" = /missing/other-command ]
if bash "$installer" --target "$fixture/missing" --prefix "$fixture/missing-prefix" > /dev/null 2>&1; then exit 1; fi
[ ! -d "$fixture/missing-prefix" ]
if bash "$installer" --prefix > /dev/null 2>&1; then exit 1; fi
printf 'CLI installation checks passed\n'
