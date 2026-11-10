import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig(
  { ignores: ["scripts/vendor/**", ".dev/**", "node_modules/**"] },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "*.config.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      camelcase: ["error", { properties: "never" }],
      curly: ["error", "all"],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_$" }],
      "object-shorthand": "error",
      "prefer-const": "error",
      "sort-imports": ["error", { ignoreCase: true, ignoreDeclarationSort: true }],
    },
  },
);
