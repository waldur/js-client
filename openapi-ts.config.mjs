import { fileURLToPath } from 'node:url';

export default {
  input: 'waldur-typescript-schema.yaml',
  output: {
    path: 'waldur-typescript-sdk',
    // Node.js only loads the compiled ESM when every relative import names
    // its file: `./client/index.js`, not `./client` (github.com/waldur/js-client#4).
    // The source names the .ts file it imports, and tsc rewrites it to .js in
    // the output (`rewriteRelativeImportExtensions` in tsconfig.json).
    module: { extension: '.ts' },
    // Absolute on purpose: the generator resolves a relative path against its
    // own install directory, not this file, and without one it searches
    // upwards from there, so it never found this tsconfig.
    tsConfigPath: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
  },
  plugins: [
    "@hey-api/sdk",
    {
      name: "@hey-api/client-fetch",
      throwOnError: true
    },
    "@hey-api/typescript",
  ],
  parser: {
    transforms: {
      // Keep a single model per schema (no Readable/Writable split) so the
      // generated type surface matches what the frontend already imports.
      // Replaces the pre-0.78 `readOnlyWriteOnlyBehavior: "off"` option.
      readWrite: {
        enabled: false,
      },
    },
  },
};
