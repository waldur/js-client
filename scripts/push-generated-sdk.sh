#!/bin/bash
# Put the SDK this pipeline generated on top of main, and push it.
#
# Runs in `Release TypeScript/JavaScript SDK`, where `Build TypeScript SDK`
# has left src/, package.json and package-lock.json in the working directory.
#
# This used to commit those onto the pipeline's own commit and then
# `git pull --rebase`, which broke in two ways:
#
#   - Two pipelines started a minute apart both rewrite the version line of
#     package.json and package-lock.json, so the later rebase conflicted.
#   - A rebase that stops leaves .git/rebase-merge behind, and the runner
#     reuses .git between jobs. Every later release job that landed on that
#     runner then failed with "there is already a rebase-merge directory",
#     for days, until the directory was cleared.
#
# There is nothing to merge in the first place: src/ is a function of the
# schema, and the version is a single field. So every attempt starts from a
# fresh clone of main, replaces src/ wholesale and sets the version, which
# cannot conflict, and starts over if main moved before the push landed. The
# clone lives in a temporary directory, so no git state, and no token, is left
# in the build directory the runner hands to the next job.
#
# Environment:
#   RELEASE_VERSION  set for a release: commit as a release and tag it
#   PUSH_REMOTE      where to push (default: this project on GitLab, via GITLAB_TOKEN)
#   PUSH_BRANCH      branch to update (default: main)
#   PUSH_ATTEMPTS    attempts before giving up on a moving branch (default: 5)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$DIR")"

BRANCH="${PUSH_BRANCH:-main}"
ATTEMPTS="${PUSH_ATTEMPTS:-5}"
if [ -z "${PUSH_REMOTE:-}" ]; then
  : "${GITLAB_TOKEN:?GITLAB_TOKEN is needed to push to ${CI_PROJECT_PATH:-the project}}"
  PUSH_REMOTE="https://gitlab-ci-token:${GITLAB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
fi

# Refuse to replace main's SDK with nothing: a missing or empty src/ means the
# build artifacts did not arrive, not that the API went away.
if [ ! -f package.json ] || [ -z "$(ls -A src 2>/dev/null)" ]; then
  echo "ERROR: src/ and package.json from 'Build TypeScript SDK' are missing; nothing to release." >&2
  exit 1
fi
GENERATED="$PWD"
VERSION=$(node -p "require('./package.json').version")

if [ -n "${RELEASE_VERSION:-}" ]; then
  MESSAGE="Release: bump version and update code to $VERSION"
else
  MESSAGE="chore: nightly update of Waldur TypeScript SDK to $VERSION"
fi

# Nightly versions end in <schema build time>.<pipeline IID>, e.g.
# 8.1.4-dev.20261111030338.646. Prints "<time> <iid>", or nothing when the
# version carries no build time (a release, or a schema without one).
build_key() {
  sed -nE 's/.*dev\.([0-9]{14})\.([0-9]+)$/\1 \2/p' <<<"$1"
}

# Whether nightly version $1 was built after nightly version $2.
built_after() {
  local key_a key_b time_a iid_a time_b iid_b
  key_a=$(build_key "$1")
  key_b=$(build_key "$2")
  [ -n "$key_a" ] && [ -n "$key_b" ] || return 1
  read -r time_a iid_a <<<"$key_a"
  read -r time_b iid_b <<<"$key_b"
  [ "$time_a" -gt "$time_b" ] || { [ "$time_a" -eq "$time_b" ] && [ "$iid_a" -gt "$iid_b" ]; }
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "Attempt $attempt/$ATTEMPTS: placing $VERSION on top of $BRANCH"
  rm -rf "$REPO"
  git clone --quiet --depth 1 --no-tags --branch "$BRANCH" "$PUSH_REMOTE" "$REPO"
  base=$(git -C "$REPO" rev-parse HEAD)
  current=$(node -p "require('$REPO/package.json').version")

  # Pipelines do not finish in the order they started. When a newer nightly
  # has already landed, this one must not put an older SDK back on main:
  # `Publish Dev to NPM` publishes main, and would move the npm `dev` tag
  # backwards.
  if [ -z "${RELEASE_VERSION:-}" ] && built_after "$current" "$VERSION"; then
    echo "$BRANCH is already at $current, built after $VERSION; leaving it there."
    exit 0
  fi

  rm -rf "$REPO/src"
  cp -R "$GENERATED/src" "$REPO/src"
  # Only the version comes from the build. Taking its package.json whole would
  # revert any change made on main since this pipeline started.
  (cd "$REPO" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
  git -C "$REPO" add -A src package.json package-lock.json

  if git -C "$REPO" diff --cached --quiet; then
    echo "$BRANCH already carries this SDK at $VERSION."
  else
    git -C "$REPO" \
      -c user.name="${GITLAB_USER_NAME:-Waldur CI}" \
      -c user.email="${GITLAB_USER_EMAIL:-ci@waldur.com}" \
      commit --quiet -m "$MESSAGE"
  fi

  refs=("HEAD:refs/heads/$BRANCH")
  if [ -n "${RELEASE_VERSION:-}" ]; then
    existing=$(git -C "$REPO" ls-remote --tags origin "refs/tags/$VERSION" | cut -f1)
    if [ -n "$existing" ]; then
      echo "Tag $VERSION already exists ($existing); leaving it as it is."
    else
      git -C "$REPO" \
        -c user.name="${GITLAB_USER_NAME:-Waldur CI}" \
        -c user.email="${GITLAB_USER_EMAIL:-ci@waldur.com}" \
        tag -a -f "$VERSION" -m "Release version $VERSION"
      refs+=("refs/tags/$VERSION")
    fi
  fi

  # Atomic, so a release never ends up with its tag pushed and main not, or
  # the reverse; the tag then always points at a commit that is on main.
  if git -C "$REPO" push --atomic origin "${refs[@]}"; then
    echo "Pushed $VERSION to $BRANCH."
    exit 0
  fi

  # Only a branch that moved under us is worth another attempt. Anything else
  # -- a revoked token, a protected branch -- fails the same way every time.
  tip=$(git -C "$REPO" ls-remote origin "refs/heads/$BRANCH" | cut -f1)
  if [ -n "$tip" ] && [ "$tip" = "$base" ]; then
    echo "ERROR: the push was rejected although $BRANCH did not move; not retrying." >&2
    exit 1
  fi
  echo "$BRANCH moved to ${tip:-<unknown>} while this attempt was in flight; starting over."
  sleep $((attempt * 3))
done

echo "ERROR: $BRANCH kept moving; gave up after $ATTEMPTS attempts." >&2
exit 1
