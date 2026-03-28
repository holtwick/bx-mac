import { writeFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox } from "./guards.js"
import { parseArgs } from "./args.js"
import { parseAllowedDirs, collectBlockedDirs, collectIgnoredPaths, generateProfile } from "./profile.js"
import { setupVSCodeProfile, buildCommand } from "./modes.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

declare const __VERSION__: string
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"

// --- --version and --help ---
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`bx ${VERSION}`)
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`bx ${VERSION} — launch apps in a macOS sandbox

Usage:
  bx [workdir]                            VSCode (default)
  bx code [workdir]                       VSCode
  bx term [workdir]                       sandboxed login shell
  bx claude [workdir]                     Claude Code CLI
  bx exec [workdir] -- command [args...]  arbitrary command

Options:
  --verbose            print the generated sandbox profile
  --profile-sandbox    use an isolated VSCode profile (code mode only)
  -v, --version        show version
  -h, --help           show this help

Configuration:
  ~/.bxallow           extra allowed directories (one per line)
  ~/.bxignore          extra blocked paths in $HOME (one per line)
  <workdir>/.bxignore  blocked paths in project (supports globs)

https://github.com/holtwick/bx-mac`)
  process.exit(0)
}

// --- Safety guards ---
checkOwnSandbox()
checkVSCodeTerminal()
checkExternalSandbox()

// --- Parse arguments ---
const { mode, workArg, verbose, profileSandbox, execCmd } = parseArgs()

const HOME = process.env.HOME!
const WORK_DIR = resolve(workArg)

// --- VSCode profile setup ---
if (mode === "code" && profileSandbox) {
  setupVSCodeProfile(HOME)
}

// --- Build sandbox profile ---
const allowedDirs = parseAllowedDirs(HOME, WORK_DIR)
const blockedDirs = collectBlockedDirs(HOME, HOME, __dirname, allowedDirs)
const ignoredPaths = collectIgnoredPaths(HOME, WORK_DIR)

const extraIgnored = ignoredPaths.length - 8 // 8 = built-in protected dotdirs
if (extraIgnored > 0) {
  console.error(`sandbox: .bxignore hides ${extraIgnored} extra path(s)`)
}

const profile = generateProfile(WORK_DIR, blockedDirs, ignoredPaths)
const profilePath = join("/tmp", `bx-${process.pid}.sb`)
writeFileSync(profilePath, profile)

console.error(`sandbox: ${mode} mode, working directory: ${WORK_DIR}`)

if (verbose) {
  console.error("\n--- Generated sandbox profile ---")
  console.error(profile)
  console.error("--- End of profile ---\n")
}

// --- Launch ---
const cmd = buildCommand(mode, WORK_DIR, HOME, profileSandbox, execCmd)

const child = spawn("sandbox-exec", [
  "-f", profilePath,
  "-D", `HOME=${HOME}`,
  "-D", `WORK=${WORK_DIR}`,
  cmd.bin,
  ...cmd.args,
], {
  cwd: WORK_DIR,
  stdio: "inherit",
  env: { ...process.env, CODEBOX_SANDBOX: "1" },
})

child.on("close", (code: number | null) => {
  rmSync(profilePath, { force: true })
  process.exit(code ?? 0)
})
