/**
 * ESLint config for @stimba/ur-control-agent.
 *
 * Intentionally minimal. We lean on TypeScript strict mode for correctness
 * (see tsconfig.json) and keep ESLint focused on hygiene that the type
 * checker doesn't cover — style inconsistencies, dead code, and footguns.
 *
 * Kept as `.eslintrc.cjs` (legacy config) because devDep `eslint@^8.57.0`
 * pre-dates flat-config-only v9. When we bump to ESLint 9+, migrate to
 * `eslint.config.js` flat config.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended"],
  env: {
    node: true,
    es2022: true,
  },
  // `NodeJS.Timeout` etc. are TypeScript ambient namespaces shipped by
  // @types/node. ESLint's parser doesn't resolve them, so declare them
  // as read-only globals to keep `no-undef` happy without disabling it.
  globals: {
    NodeJS: "readonly",
  },
  rules: {
    // TS parser handles type-aware unused detection better than core ESLint,
    // and we want `_ignored` to be a valid opt-out.
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],

    // Our reconnect/retry loops use `while (true)` by design.
    "no-constant-condition": ["error", { checkLoops: false }],

    // Fastify/pino APIs sometimes surface `any` at the boundary; we guard
    // with Zod rather than annotations, so don't fail CI over it.
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "coverage/",
    "*.cjs", // don't lint the config file itself
  ],
};
