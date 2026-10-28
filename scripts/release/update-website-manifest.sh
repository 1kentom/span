#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_CHANNEL:?RELEASE_CHANNEL is required}"
if [[ "${GITHUB_REPOSITORY:-}" != "1kentom/span" ]]; then
  echo 'Website metadata updates are restricted to 1kentom/span.' >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  echo 'A server-side GitHub token is required.' >&2
  exit 1
fi
case "$RELEASE_CHANNEL" in
  nightly|preview|stable) ;;
  *) echo 'Unsupported release channel.' >&2; exit 1 ;;
esac
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Refusing to update metadata in a checkout with tracked changes.' >&2
  exit 1
fi

gh auth setup-git
for manifest_attempt in 1 2 3; do
  git fetch --no-tags origin refs/heads/main
  git checkout --detach FETCH_HEAD
  node apps/web/scripts/sync-releases.mjs --tag "$RELEASE_TAG" --channel "$RELEASE_CHANNEL"
  git add -- apps/web/releases.json
  if git diff --cached --quiet -- apps/web/releases.json; then
    echo 'Website release metadata is already current.'
    exit 0
  fi
  git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m "chore(web): refresh $RELEASE_CHANNEL release downloads"
  if git push origin HEAD:refs/heads/main; then
    echo 'Published the verified website release manifest.'
    exit 0
  fi
  echo "Fast-forward push failed (attempt $manifest_attempt of 3); reloading main." >&2
done

echo 'Could not update website metadata after three fast-forward attempts.' >&2
exit 1
