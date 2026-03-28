import { defineConfig } from "rolldown"

export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/bx.js",
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
  platform: "node",
})
