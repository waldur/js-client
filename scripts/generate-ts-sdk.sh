#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$DIR")"
cd "$PROJECT_DIR"

echo "Generating TypeScript from schema..."
npx --yes -p typescript@5.9.3 -p @hey-api/openapi-ts@0.97.3 openapi-ts -i waldur-typescript-schema.yaml

echo "Post-processing generated code..."
node scripts/patch-sdk.mjs

echo "TypeScript SDK regeneration and patching completed."
