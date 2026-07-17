#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$DIR")"
cd "$PROJECT_DIR"

echo "Updating package version..."
# Resolve the version from waldur-typescript-schema.yaml
if [ -f waldur-typescript-schema.yaml ] && command -v yq >/dev/null 2>&1; then
  DEV_VERSION=$(yq '.info.version' waldur-typescript-schema.yaml | tr -d '"' | tr -d "'")
  if [ -z "$DEV_VERSION" ] || [ "$DEV_VERSION" = "null" ]; then
    DEV_VERSION="0.0.0"
  fi
  
  if [ -z "$RELEASE_VERSION" ]; then
    if echo "$DEV_VERSION" | grep -q "dev"; then
      DEV_VERSION="${DEV_VERSION}.${CI_PIPELINE_IID}"
    elif echo "$DEV_VERSION" | grep -q "-"; then
      DEV_VERSION="${DEV_VERSION}.dev.${CI_PIPELINE_IID}"
    else
      DEV_VERSION="${DEV_VERSION}-dev.${CI_PIPELINE_IID}"
    fi
  else
    DEV_VERSION="$RELEASE_VERSION"
  fi
  
  echo "Setting version to $DEV_VERSION"
  npm version "$DEV_VERSION" --no-git-tag-version
else
  echo "Warning: waldur-typescript-schema.yaml or yq not found. Skipping version update."
fi

echo "Installing npm dependencies..."
npm install

echo "Generating TypeScript from schema..."
npx --yes -p typescript@5.9.3 -p @hey-api/openapi-ts@0.97.3 openapi-ts -i waldur-typescript-schema.yaml

echo "Post-processing generated code..."
node scripts/patch-sdk.mjs

echo "Compiling TS source code..."
rm -rf src
mv waldur-typescript-sdk src
npm run build

echo "TypeScript SDK regeneration, patching, and compilation completed."
