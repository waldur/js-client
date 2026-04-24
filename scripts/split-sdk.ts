#!/usr/bin/env npx ts-node
import { Project, Node } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

// ── Configuration ──────────────────────────────────────────────────────────────
const srcDir = process.env.SDK_SRC || path.join(process.cwd(), "src");
const outDir =
  process.env.SDK_OUT || path.join(process.cwd(), "waldur-typescript-sdk-modular");
const packagesDir = path.join(outDir, "packages");

// Module definitions: map module name → set of function-name prefixes
const MODULE_PREFIXES: Record<string, string[]> = {
  // IaaS providers
  openstack: ["openstack"],
  azure: ["azure"],
  aws: ["aws"],
  digitalocean: ["digitalocean"],
  vmware: ["vmware"],
  rancher: ["rancher", "managedRancherCluster"],
  slurm: ["slurm"],

  // Core business domains
  marketplace: ["marketplace", "booking", "backend", "offeringKeycloak", "remote"],
  proposal: [
    "proposal",
    "call",
    "assignmentBatches",
    "myAssignmentBatches",
    "assignmentItems",
    "coiDetectionJobs",
    "coiDisclosures",
    "conflictsOfInterest",
    "expertiseCategories",
    "reviewerBids",
    "reviewerInvitations",
    "reviewerProfiles",
    "nestedReviewerProfile",
    "reviewerSuggestions",
  ],
  billing: [
    "invoice",
    "invoices",
    "financial",
    "billing",
    "payments",
    "payment",
    "provider",
    "promotions",
  ],

  // User & org management
  auth: [
    "apiAuth",
    "auth",
    "user",
    "users",
    "freeipa",
    "keycloak",
    "identity",
    "onboarding",
    "personalAccessTokens",
  ],
  structure: [
    "customer",
    "customers",
    "project",
    "projects",
    "affiliatedOrganizations",
  ],

  // Operations
  support: ["support", "sync", "chat"],
  notifications: ["broadcast", "notification", "email", "hooks"],
  admin: [
    "admin",
    "override",
    "feature",
    "configuration",
    "version",
    "celery",
    "database",
    "rabbitmq",
    "daily",
    "media",
    "query",
    "service",
    "roles",
    "organization",
    "external",
    "lexis",
    "google",
    "access",
    "autoprovisioning",
    "component",
    "keys",
    "event",
    "events",
    "maintenance",
    "public",
    "checklists",
    "debug",
    "systemLogs",
    "stats",
    "dataAccessLogs",
    "metadata",
  ],

  // OpenPortal
  openportal: ["openportal"],
};

const CORE = "core";
const ALL_MODULES = [CORE, ...Object.keys(MODULE_PREFIXES)];

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(outDir);
ensureDir(packagesDir);

// ── Step 0: Load project ───────────────────────────────────────────────────────
console.log("Loading project...");
const project = new Project({ skipAddingFilesFromTsConfig: true });
const typesFile = project.addSourceFileAtPath(path.join(srcDir, "types.gen.ts"));
const sdkFile = project.addSourceFileAtPath(path.join(srcDir, "sdk.gen.ts"));
const clientGenFile = project.addSourceFileAtPath(
  path.join(srcDir, "client.gen.ts"),
);

// ── Step 1: Classify each SDK function into a module ───────────────────────────
console.log("Classifying SDK functions...");
const functionToModule = new Map<string, string>();
const moduleTypeRefs = new Map<string, Set<string>>(); // module → referenced type names

ALL_MODULES.forEach((m) => moduleTypeRefs.set(m, new Set()));

for (const stmt of sdkFile.getVariableStatements()) {
  const decl = stmt.getDeclarations()[0];
  const funcName = decl.getName();

  // Consolidation: drop querySerializer because it is producing explode: false for multiple choice filter
  const init = decl.getInitializer();
  if (init && Node.isCallExpression(init)) {
    const args = init.getArguments();
    if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
      const obj = args[0];

      // Improvement: Remove querySerializer
      const prop = obj.getProperty("querySerializer");
      if (prop) prop.remove();

      // Improvement: Deduplicate security schemes
      const securityProp = obj.getProperty("security");
      if (securityProp && Node.isPropertyAssignment(securityProp)) {
        const securityInit = securityProp.getInitializer();
        if (securityInit && Node.isArrayLiteralExpression(securityInit)) {
          const seen = new Set<string>();
          const elements = securityInit.getElements();
          for (let i = elements.length - 1; i >= 0; i--) {
            const el = elements[i];
            const text = el.getText().replace(/\s+/g, "");
            if (seen.has(text)) {
              securityInit.removeElement(i);
            } else {
              seen.add(text);
            }
          }
        }
      }
    }
  }

  // Determine module from function name prefix
  let assignedModule = CORE;
  for (const [mod, prefixes] of Object.entries(MODULE_PREFIXES)) {
    for (const prefix of prefixes) {
      if (funcName.toLowerCase().startsWith(prefix.toLowerCase())) {
        assignedModule = mod;
        break;
      }
    }
    if (assignedModule !== CORE) break;
  }

  functionToModule.set(funcName, assignedModule);
  const refs = moduleTypeRefs.get(assignedModule)!;
  stmt.forEachDescendant((node: Node) => {
    if (Node.isTypeReference(node)) {
      refs.add(node.getTypeName().getText());
    }
  });
}

// Also collect types from client.gen.ts (foundational)
const coreRefs = moduleTypeRefs.get(CORE)!;
clientGenFile.forEachDescendant((node: Node) => {
  if (Node.isTypeReference(node)) {
    coreRefs.add(node.getTypeName().getText());
  }
});

console.log(
  `  Functions: core=${[...functionToModule.values()].filter((v) => v === CORE).length}, ` +
  Object.keys(MODULE_PREFIXES)
    .map(
      (m) =>
        `${m}=${[...functionToModule.values()].filter((v) => v === m).length}`,
    )
    .join(", "),
);

// ── Step 2: Build type dependency DAG from types.gen.ts ────────────────────────
console.log("Building type dependency DAG...");
const allTypes = new Map<string, string>(); // typeName → full text
const typeDeps = new Map<string, Set<string>>(); // typeName → set of depTypeNames

for (const stmt of typesFile.getStatements()) {
  if (
    Node.isTypeAliasDeclaration(stmt) ||
    Node.isInterfaceDeclaration(stmt) ||
    Node.isEnumDeclaration(stmt)
  ) {
    const name = stmt.getName();
    allTypes.set(name, stmt.getFullText());

    const deps = new Set<string>();
    stmt.forEachDescendant((node: Node) => {
      if (Node.isTypeReference(node)) {
        const refName = node.getTypeName().getText();
        if (refName !== name) deps.add(refName); // skip self-refs
      }
    });
    typeDeps.set(name, deps);
  }
}

console.log(`  Total types in types.gen.ts: ${allTypes.size}`);

// ── Step 3: Compute transitive closure of dependencies per type ────────────────
function getTransitiveDeps(
  typeName: string,
  visited = new Set<string>(),
): Set<string> {
  if (visited.has(typeName)) return visited;
  visited.add(typeName);
  const directDeps = typeDeps.get(typeName);
  if (directDeps) {
    for (const dep of directDeps) {
      getTransitiveDeps(dep, visited);
    }
  }
  return visited;
}

// ── Step 4: Classify types ─────────────────────────────────────────────────────
console.log("Classifying types...");
const typeUsage = new Map<string, Set<string>>(); // typeName → set of modules

for (const [mod, refs] of moduleTypeRefs) {
  for (const ref of refs) {
    const closure = getTransitiveDeps(ref, new Set());
    for (const typeName of closure) {
      if (!allTypes.has(typeName)) continue;
      if (!typeUsage.has(typeName)) typeUsage.set(typeName, new Set());
      typeUsage.get(typeName)!.add(mod);
    }
  }
}

const typeToModule = new Map<string, string>();
for (const [typeName] of allTypes) {
  const usage = typeUsage.get(typeName);
  if (usage && usage.size === 1) {
    typeToModule.set(typeName, [...usage][0]);
  } else if (usage && usage.size > 1) {
    typeToModule.set(typeName, CORE);
  }
}

// Propagate dependencies to core
let promoted = true;
while (promoted) {
  promoted = false;
  for (const [typeName, mod] of typeToModule) {
    if (mod !== CORE) continue;
    const deps = typeDeps.get(typeName);
    if (!deps) continue;
    for (const dep of deps) {
      if (typeToModule.get(dep) !== CORE && allTypes.has(dep)) {
        typeToModule.set(dep, CORE);
        promoted = true;
      }
    }
  }
}

const typeCounts: Record<string, number> = {};
ALL_MODULES.forEach((m) => (typeCounts[m] = 0));
for (const [, mod] of typeToModule)
  typeCounts[mod] = (typeCounts[mod] || 0) + 1;
console.log("  Type classification:", JSON.stringify(typeCounts));

// ── Step 5: Extract SDK-level type declarations (Options, etc.) ────────────────
const sdkSharedTypes: string[] = [];
for (const stmt of sdkFile.getStatements()) {
  if (Node.isTypeAliasDeclaration(stmt) || Node.isInterfaceDeclaration(stmt)) {
    sdkSharedTypes.push(stmt.getFullText());
  }
}

// ── Step 6: Generate output packages ───────────────────────────────────────────
console.log("Generating packages...");

const moduleTypes = new Map<string, string[]>();
ALL_MODULES.forEach((m) => moduleTypes.set(m, []));
for (const [typeName, mod] of typeToModule) {
  moduleTypes.get(mod)!.push(typeName);
}

function buildTypeImports(usedTypes: Set<string>, currentModule: string): string {
  const lines: string[] = [];
  const fromCore: string[] = [];
  const fromOwn: string[] = [];
  const fromOther = new Map<string, string[]>();

  for (const t of usedTypes) {
    if (!allTypes.has(t)) continue;
    const srcMod = typeToModule.get(t)!;
    if (srcMod === currentModule) {
      fromOwn.push(t);
    } else if (srcMod === CORE) {
      fromCore.push(t);
    } else {
      if (!fromOther.has(srcMod)) fromOther.set(srcMod, []);
      fromOther.get(srcMod)!.push(t);
    }
  }

  if (fromCore.length > 0) {
    const specifier = currentModule === CORE ? "./types.gen" : "@waldur/core";
    lines.push(
      `import type { ${fromCore.sort().join(", ")} } from '${specifier}';`,
    );
  }
  if (fromOwn.length > 0) {
    lines.push(
      `import type { ${fromOwn.sort().join(", ")} } from './types.gen';`,
    );
  }
  for (const [mod, types] of fromOther) {
    lines.push(
      `import type { ${types.sort().join(", ")} } from '@waldur/${mod}';`,
    );
  }
  return lines.join("\n");
}

for (const mod of ALL_MODULES) {
  const modDir = path.join(packagesDir, mod, "src");
  ensureDir(modDir);

  // types.gen.ts
  const typeNames = moduleTypes.get(mod)!;
  const typesContent: string[] = [
    "// This file is auto-generated by split-sdk script\n",
  ];
  const typeDepsForModule = new Set<string>();
  for (const tn of typeNames) {
    const deps = typeDeps.get(tn);
    if (deps) {
      for (const dep of deps) {
        if (!typeNames.includes(dep)) typeDepsForModule.add(dep);
      }
    }
  }
  if (typeDepsForModule.size > 0) {
    typesContent.push(buildTypeImports(typeDepsForModule, mod));
    typesContent.push("");
  }
  for (const tn of typeNames) {
    typesContent.push(allTypes.get(tn)!.trim());
    typesContent.push("");
  }
  fs.writeFileSync(path.join(modDir, "types.gen.ts"), typesContent.join("\n"));

  // sdk.gen.ts
  const sdkContent: string[] = [
    "// This file is auto-generated by split-sdk script\n",
  ];
  if (mod === CORE) {
    sdkContent.push(
      "import type { Client, Options as ClientOptions, TDataShape } from './client';",
    );
    sdkContent.push("import { client as _heyApiClient } from './client.gen';");
  } else {
    sdkContent.push("import type { Options } from '@waldur/core';");
    sdkContent.push("import { client as _heyApiClient } from '@waldur/core';");
  }
  sdkContent.push("");

  if (mod === CORE) {
    for (const t of sdkSharedTypes) {
      sdkContent.push(t.trim());
      sdkContent.push("");
    }
  }

  const sdkFunctions: string[] = [];
  const sdkTypeRefs = new Set<string>();
  for (const stmt of sdkFile.getVariableStatements()) {
    const decl = stmt.getDeclarations()[0];
    const funcName = decl.getName();
    if (functionToModule.get(funcName) !== mod) continue;
    sdkFunctions.push(stmt.getFullText().trim());
    stmt.forEachDescendant((node: Node) => {
      if (Node.isTypeReference(node)) {
        sdkTypeRefs.add(node.getTypeName().getText());
      }
    });
  }
  const builtInOrSdkTypes = new Set([
    "Options",
    "Options2",
    "Client",
    "TDataShape",
    "ThrowOnError",
  ]);
  const importableTypes = new Set(
    [...sdkTypeRefs].filter((t) => !builtInOrSdkTypes.has(t)),
  );
  if (importableTypes.size > 0) {
    sdkContent.push(buildTypeImports(importableTypes, mod));
    sdkContent.push("");
  }
  for (const fn of sdkFunctions) {
    sdkContent.push(fn);
    sdkContent.push("");
  }
  fs.writeFileSync(path.join(modDir, "sdk.gen.ts"), sdkContent.join("\n"));

  // index.ts
  const indexContent: string[] = [];
  indexContent.push("export * from './types.gen';");
  indexContent.push("export * from './sdk.gen';");
  if (mod === CORE) {
    indexContent.push("export { client } from './client.gen';");
    indexContent.push(
      "export type { CreateClientConfig } from './client.gen';",
    );
    indexContent.push(
      'export { formDataBodySerializer, RequestResult } from "./client";',
    );
  }
  fs.writeFileSync(
    path.join(modDir, "index.ts"),
    indexContent.join("\n") + "\n",
  );

  // package.json
  const pkgDeps: Record<string, string> = {};
  if (mod !== CORE) {
    pkgDeps["@waldur/core"] = "*";
    const allModuleTypeRefs = new Set<string>([
      ...typeDepsForModule,
      ...importableTypes,
    ]);
    for (const t of allModuleTypeRefs) {
      if (!allTypes.has(t)) continue;
      const srcMod = typeToModule.get(t)!;
      if (srcMod !== mod && srcMod !== CORE) {
        pkgDeps[`@waldur/${srcMod}`] = "*";
      }
    }
  }
  const pkg = {
    name: `@waldur/${mod}`,
    version: "1.0.0",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    scripts: { build: "tsc" },
    dependencies: pkgDeps,
    devDependencies: { typescript: "^5.8.2" },
    exports: {
      ".": "./dist/index.js",
      "./types.gen": "./dist/types.gen.js",
      "./sdk.gen": "./dist/sdk.gen.js",
    },
  };
  fs.writeFileSync(
    path.join(packagesDir, mod, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );

  // tsconfig.json
  const tsconfig: any = {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      declaration: true,
      composite: true,
      outDir: "./dist",
      rootDir: "./src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
  };
  if (Object.keys(pkgDeps).length > 0) {
    tsconfig.compilerOptions.paths = {};
    tsconfig.references = [];
    for (const dep of Object.keys(pkgDeps)) {
      const depName = dep.replace("@waldur/", "");
      tsconfig.compilerOptions.paths[dep] = [`../${depName}/src`];
      tsconfig.compilerOptions.paths[`${dep}/*`] = [`../${depName}/src/*`];
      tsconfig.references.push({ path: `../${depName}` });
    }
  }
  fs.writeFileSync(
    path.join(packagesDir, mod, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2) + "\n",
  );
}

// Copy infrastructure
console.log("Copying infrastructure to core...");
const coreSrcDir = path.join(packagesDir, "core", "src");
["client", "core"].forEach((dir) => {
  const dest = path.join(coreSrcDir, dir);
  ensureDir(dest);
  fs.readdirSync(path.join(srcDir, dir)).forEach((f) => {
    if (f !== "sdk.gen.ts")
      fs.copyFileSync(path.join(srcDir, dir, f), path.join(dest, f));
  });
});
fs.copyFileSync(
  path.join(srcDir, "client.gen.ts"),
  path.join(coreSrcDir, "client.gen.ts"),
);

// Legacy wrapper
console.log("Generating legacy wrapper package...");
const wrapperDir = path.join(packagesDir, "client");
ensureDir(path.join(wrapperDir, "src"));
const wrapperDeps: Record<string, string> = {};
const wrapperBarrel = ["// Auto-generated legacy wrapper"];
for (const mod of ALL_MODULES) {
  wrapperBarrel.push(`export * from '@waldur/${mod}';`);
  wrapperDeps[`@waldur/${mod}`] = "*";
}
fs.writeFileSync(
  path.join(wrapperDir, "src", "index.ts"),
  wrapperBarrel.join("\n") + "\n",
);
fs.writeFileSync(
  path.join(wrapperDir, "package.json"),
  JSON.stringify(
    {
      name: "waldur-js-client",
      version: "1.0.0",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: { build: "tsc" },
      dependencies: wrapperDeps,
      devDependencies: { typescript: "^5.8.2" },
      exports: { ".": "./dist/index.js" },
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  path.join(wrapperDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "bundler",
        declaration: true,
        composite: true,
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["src/**/*"],
      references: ALL_MODULES.map((m) => ({ path: `../${m}` })),
    },
    null,
    2,
  ) + "\n",
);

// Root structure
console.log("Generating monorepo root structure...");
fs.writeFileSync(
  path.join(outDir, ".gitignore"),
  "node_modules/\ndist/\n*.tsbuildinfo\n*.log\n.DS_Store\n",
);
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(
    {
      name: "@waldur/monorepo",
      version: "1.0.0",
      private: true,
      workspaces: [
        ...ALL_MODULES.map((m) => `packages/${m}`),
        "packages/client",
      ],
      scripts: { build: "npm run build --workspaces" },
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      files: [],
      references: [
        ...ALL_MODULES.map((m) => ({ path: `./packages/${m}` })),
        { path: "./packages/client" },
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("\n✅ Done!");
