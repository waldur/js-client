#!/bin/bash
# Installs the packed SDK into an empty project and uses it from Node.js the
# way a consumer would: ESM import, CommonJS require, every subpath export, a
# real request against a local server, and a type-check under the two module
# resolutions consumers use (nodenext for Node, bundler for Vite).
#
# 8.1.x shipped extensionless imports that bundlers accept and Node refuses
# (ERR_UNSUPPORTED_DIR_IMPORT, github.com/waldur/js-client#4). Nothing ran the
# package in Node before it was published, so this does.
#
# Run after `npm run build`; it tests dist/ as `npm pack` would publish it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$DIR")"
cd "$PROJECT_DIR"

echo "Node $(node --version)"

[ -f dist/index.js ] || { echo "dist/ is missing; run npm run build first" >&2; exit 1; }

# tsc rewrites `./foo.ts` to `./foo.js` only in emitted JavaScript. A relative
# specifier without an extension, or one still ending in .ts, cannot load in Node.
bad=$(grep -rnoE "(from|import)\s*\(?\s*['\"]\.{1,2}/[^'\"]*['\"]" dist --include='*.js' \
  | grep -vE "\.js['\"]$" || true)
if [ -n "$bad" ]; then
  echo "Compiled JavaScript has relative imports Node cannot resolve:" >&2
  echo "$bad" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

npm pack --silent --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/waldur-js-client-*.tgz)"

APP="$WORK/app"
mkdir -p "$APP"
cd "$APP"
echo '{"name":"consumer","private":true,"type":"module"}' > package.json
npm install --silent --no-audit --no-fund "$TARBALL"

# A server that answers the one endpoint the tests call, and records the request.
cat > server.mjs <<'EOF'
import http from 'node:http';
export function start() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/api/customers/' || req.url.startsWith('/api/customers/?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ uuid: 'c1', name: 'Customer 1' }]));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Not found.' }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() });
    });
  });
}
EOF

echo "ESM: import every export and make a request"
cat > esm.mjs <<'EOF'
import assert from 'node:assert/strict';
import { start } from './server.mjs';
import * as root from 'waldur-js-client';
import { client } from 'waldur-js-client/client.gen';
import * as sdk from 'waldur-js-client/sdk.gen';
await import('waldur-js-client/types.gen');

assert.equal(typeof root.customersList, 'function');
assert.equal(typeof root.formDataBodySerializer?.bodySerializer, 'function');
assert.equal(typeof sdk.customersList, 'function');

const server = await start();
try {
  client.setConfig({ baseUrl: server.baseUrl, auth: () => 'secret-token' });
  const { data, response } = await root.customersList({ query: { page: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(data, [{ uuid: 'c1', name: 'Customer 1' }]);
  assert.equal(server.requests[0].url, '/api/customers/?page=1');
  assert.ok(server.requests[0].auth?.includes('secret-token'), 'auth header was not sent');

  // The client is generated with throwOnError, so an error status must reject.
  await assert.rejects(root.customersRetrieve({ path: { uuid: 'missing' } }));
} finally {
  server.close();
}
console.log('  ok');
EOF
node esm.mjs

echo "CommonJS: require the package"
cat > cjs.cjs <<'EOF'
const assert = require('node:assert/strict');
const root = require('waldur-js-client');
const { client } = require('waldur-js-client/client.gen');
assert.equal(typeof root.customersList, 'function');
assert.equal(typeof client.setConfig, 'function');
console.log('  ok');
EOF
node cjs.cjs

echo "Types: type-check a consumer"
cat > consumer.ts <<'EOF'
import { customersList, type Customer, type RequestResult } from 'waldur-js-client';
import { client } from 'waldur-js-client/client.gen';
import type { CustomersListData } from 'waldur-js-client/types.gen';

client.setConfig({ baseUrl: 'http://localhost' });
const query: CustomersListData['query'] = { page: 1 };
export async function names(): Promise<string[]> {
  const { data } = await customersList({ query });
  return data.map((c: Customer) => c.name);
}
export type Result = RequestResult<Customer[], unknown>;
EOF
TSC="$PROJECT_DIR/node_modules/.bin/tsc"
for resolution in nodenext bundler; do
  module=$([ "$resolution" = nodenext ] && echo nodenext || echo esnext)
  echo "  moduleResolution=$resolution"
  "$TSC" --noEmit --strict --skipLibCheck false --target es2023 \
    --module "$module" --moduleResolution "$resolution" consumer.ts
done

echo "The SDK works from Node.js $(node --version)."
