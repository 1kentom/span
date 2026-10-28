#!/usr/bin/env bash
# Install a user-requested detached launcher after the native application is installed.
set -euo pipefail
prefix=''
target=''
dry_run=false
script_dir=$(cd "$(dirname "$0")" && pwd)
launcher="$script_dir/span-launcher.sh"
[ -f "$launcher" ] || { printf 'Launcher source is unavailable: %s\n' "$launcher" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: install-cli.sh [--prefix DIRECTORY] [--target EXECUTABLE] [--dry-run]

Creates a detached launcher at DIRECTORY/bin/span when --prefix is provided. Otherwise chooses a
writable /opt/homebrew/bin or /usr/local/bin already on PATH, falling back to
~/.local/bin. Never changes shell configuration or replaces an unrelated command.
On macOS the default executable is /Applications/span.app/Contents/MacOS/span-desktop.
On Linux pass --target with the absolute path of the installed span-desktop binary.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--target)
      option="$1"
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf '%s requires a value\n' "$option" >&2; exit 2; }
      case "$2" in /*) ;; *) printf '%s must be an absolute path\n' "$option" >&2; exit 2;; esac
      if [ "$option" = --prefix ]; then prefix="$2"; else target="$2"; fi
      shift 2;;
    --dry-run) dry_run=true; shift;;
    --help|-h) usage; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2;;
  esac
done
if [ -z "$target" ]; then
  if [ "$(uname -s)" = Darwin ]; then target='/Applications/span.app/Contents/MacOS/span-desktop'
  else printf 'Pass --target with the absolute installed span-desktop executable path.\n' >&2; exit 2; fi
fi
if [ ! -f "$target" ] || [ ! -x "$target" ]; then
  printf 'Install the native application first. Executable not found: %s\n' "$target" >&2
  exit 1
fi
if [ -n "$prefix" ]; then bin_dir="${prefix%/}/bin"
else
  bin_dir="${HOME:?HOME is required}/.local/bin"
  for candidate in /opt/homebrew/bin /usr/local/bin; do
    case ":${PATH:-}:" in *":$candidate:"*)
      if [ -d "$candidate" ] && [ -w "$candidate" ]; then bin_dir="$candidate"; break; fi;;
    esac
  done
fi
link="$bin_dir/span"
if [ -L "$link" ]; then
  existing=$(readlink "$link")
  if [ "$existing" != "$target" ]; then
    printf 'Refusing to replace an existing span command: %s -> %s\n' "$link" "$existing" >&2
    exit 1
  fi
elif [ -f "$link" ] && /usr/bin/grep -qFx '# span-managed-launcher-v1' "$link"; then
  :
elif [ -e "$link" ]; then
  printf 'Refusing to replace an existing span command: %s\n' "$link" >&2
  exit 1
fi
# An earlier command on PATH would hide the newly installed link.
existing_command=$(command -v span 2>/dev/null || true)
if [ -n "$existing_command" ] && [ "$existing_command" != "$link" ]; then
  printf 'An existing span command is already on PATH: %s. Resolve that command before installing.\n' "$existing_command" >&2
  exit 1
fi
if "$dry_run"; then
  printf 'Would install detached launcher %s for %s\n' "$link" "$target"
else
  mkdir -p "$bin_dir"
  temporary=$(mktemp "$bin_dir/.span-launcher.XXXXXX")
  trap 'if [ -n "${temporary:-}" ] && [ -f "$temporary" ]; then /bin/unlink "$temporary"; fi' EXIT
  {
    printf '#!/bin/bash\n# span-managed-launcher-v1\n'
    printf 'SPAN_EXECUTABLE=%q\n' "$target"
    /usr/bin/tail -n +3 "$launcher"
  } > "$temporary"
  chmod 755 "$temporary"
  # Rename replaces our old managed symlink itself, never its app target.
  mv -f "$temporary" "$link"
  temporary=''
  printf 'CLI available at %s\n' "$link"
fi
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this directory to PATH in your shell configuration: %s\n' "$bin_dir";;
esac
