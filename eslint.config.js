import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"

export default defineConfig([
  globalIgnores([
    "build/",
    "dist/",
    "coverage/",
    "debian/build/",
    "debian/.debhelper/",
    "debian/omp-instance-control/",
  ]),
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
