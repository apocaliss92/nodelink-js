import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "app/dist/**",
      "app/public/**",
      "node_modules/**",
      "app/node_modules/**",
      "_refs/**",
      ".tmp/**",
      ".venv/**",
      "**/.venv/**",
      ".venv*/**",
      "**/.venv*/**",
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
      // We still report these as warnings (not failing) so they can be cleaned up incrementally.
      "prefer-const": "warn",
      "no-empty": "warn",

      // JS
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

      // TS-only rules
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "warn",
    }
  },
  // TS files: use the TS-aware unused-vars rule and disable the base rule to avoid duplicates.
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

