#!/bin/bash
# span-managed-launcher-v1
# The installer places a shell-quoted SPAN_EXECUTABLE assignment above this body.
set -euo pipefail
if [ -z "${SPAN_EXECUTABLE:-}" ] || [ ! -x "$SPAN_EXECUTABLE" ]; then
  printf 'Span executable is unavailable: %s\n' "${SPAN_EXECUTABLE:-unset}" >&2
  exit 1
fi
args=()
positional=false
goto_pending=false
for arg in "$@"; do
  if ! "$positional"; then
    case "$arg" in
      --help|-h|--version|-V) exec "$SPAN_EXECUTABLE" "$@";;
      --) if "$goto_pending"; then exec "$SPAN_EXECUTABLE" "$@"; fi; positional=true; args+=("$arg"); continue;;
      --goto) if "$goto_pending"; then exec "$SPAN_EXECUTABLE" "$@"; fi; goto_pending=true; args+=("$arg"); continue;;
      -*) exec "$SPAN_EXECUTABLE" "$@";;
    esac
  fi
  if [ -z "$arg" ]; then exec "$SPAN_EXECUTABLE" "$@"; fi
  case "$arg" in /*) args+=("$arg");; *) args+=("$PWD/$arg");; esac
  goto_pending=false
done
if "$goto_pending"; then exec "$SPAN_EXECUTABLE" "$@"; fi
# open starts a LaunchServices-owned process. -n delivers each invocation's args
# to the single-instance bridge even when the app is already running.
if [ "$(uname -s)" = Darwin ]; then
  case "$SPAN_EXECUTABLE" in
    *.app/Contents/MacOS/*)
      app="${SPAN_EXECUTABLE%/Contents/MacOS/*}"
      exec /usr/bin/open -n -a "$app" --args ${args[@]+"${args[@]}"};;
  esac
fi
# Linux normally supplies setsid. The fallback starts a separate process group
# with bash job control, ignores hangup, and detaches all terminal descriptors.
if command -v setsid >/dev/null 2>&1; then
  nohup setsid "$SPAN_EXECUTABLE" ${args[@]+"${args[@]}"} </dev/null >/dev/null 2>&1 &
else
  set -m
  (trap '' HUP; exec "$SPAN_EXECUTABLE" ${args[@]+"${args[@]}"}) </dev/null >/dev/null 2>&1 &
  disown "$!"
fi
exit 0
