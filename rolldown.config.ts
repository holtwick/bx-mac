import { defineConfig } from "rolldown"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/bx.js",
    format: "esm",
    banner: `#!/usr/bin/env node\nconst __VERSION__ = ${JSON.stringify(pkg.version)};`,
  },
  platform: "node",
})
