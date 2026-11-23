// ESLint "flat config" (ESLint 9+). Each object below is a layer; later layers win.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  // Type-aware rules: they read tsconfig.json so they can catch things like
  // un-awaited promises (a common Node bug, like a missing `await` on a Task in C#).
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Plain .js files (like this one) are not in tsconfig, so switch the type-aware rules off for them.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
