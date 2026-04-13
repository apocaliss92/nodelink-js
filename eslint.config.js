import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "app/dist/**",
      "app/public/**",
      "app/client/public/**",
      "node_modules/**",
      "app/node_modules/**",
      "_refs/**",
      ".tmp/**",
      ".nx/**",
      ".venv/**",
      "**/.venv/**",
      ".venv*/**",
      "**/.venv*/**",
      "test/capture-*.ts",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Keep "recommended" baseline, but avoid noisy refactors on an existing codebase.
      "prefer-const": "warn",
      "no-empty": "warn",
      "no-cond-assign": "warn",
      "no-unreachable": "warn",
      "no-regex-spaces": "warn",
      "no-constant-binary-expression": "warn",
      "no-useless-escape": "warn",
      "no-undef": "off",

      // JS
      "no-unused-vars": "off",

      // TS-only rules — all as warnings to avoid blocking CI on pre-existing code
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
    }
  },
  // Override for JS files (non-TS)
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
