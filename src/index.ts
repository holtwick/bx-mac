import { writeFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox, checkWorkDirs } from "./guards.js"
import { parseArgs } from "./args.js"
import { PROTECTED_DOTDIRS, parseAllowedDirs, collectBlockedDirs, collectIgnoredPaths, generateProfile } from "./profile.js"
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
  bx [workdir...]                            VSCode (default)
  bx code [workdir...]                       VSCode
  bx term [workdir...]                       sandboxed login shell
  bx claude [workdir...]                     Claude Code CLI
  bx exec [workdir...] -- command [args...]  arbitrary command

Options:
  --verbose            print the generated sandbox profile
  --profile-sandbox    use an isolated VSCode profile (code mode only)
  -v, --version        show version
  -h, --help           show this help

Configuration:
  ~/.bxallow           extra allowed directories (one per line)
  ~/.bxignore          extra blocked paths in $HOME (one per line)
  <workdir>/.bxignore  blocked paths in project (supports globs, searched recursively)

https://github.com/holtwick/bx-mac`)
  process.exit(0)
}

// --- Safety guards ---
checkOwnSandbox()
checkVSCodeTerminal()
checkExternalSandbox()

// --- Parse arguments ---
const { mode, workArgs, verbose, profileSandbox, execCmd } = parseArgs()

const HOME = process.env.HOME!
const WORK_DIRS = workArgs.map((a) => resolve(a))

checkWorkDirs(WORK_DIRS, HOME)

// --- VSCode profile setup ---
if (mode === "code" && profileSandbox) {
  setupVSCodeProfile(HOME)
}

// --- Build sandbox profile ---
const allowedDirs = parseAllowedDirs(HOME, WORK_DIRS)
const blockedDirs = collectBlockedDirs(HOME, HOME, __dirname, allowedDirs)
const ignoredPaths = collectIgnoredPaths(HOME, WORK_DIRS)

const extraIgnored = ignoredPaths.length - PROTECTED_DOTDIRS.length
if (extraIgnored > 0) {
  console.error(`sandbox: .bxignore hides ${extraIgnored} extra path(s)`)
}

const profile = generateProfile(WORK_DIRS, blockedDirs, ignoredPaths)
const profilePath = join("/tmp", `bx-${process.pid}.sb`)
writeFileSync(profilePath, profile)

const dirLabel = WORK_DIRS.length === 1 ? WORK_DIRS[0] : `${WORK_DIRS.length} directories`
console.error(`sandbox: ${mode} mode, working directory: ${dirLabel}`)

if (verbose) {
  console.error("\n--- Generated sandbox profile ---")
  console.error(profile)
  console.error("--- End of profile ---\n")
}

// --- Launch ---
const cmd = buildCommand(mode, WORK_DIRS, HOME, profileSandbox, execCmd)

const child = spawn("sandbox-exec", [
  "-f", profilePath,
  "-D", `HOME=${HOME}`,
  "-D", `WORK=${WORK_DIRS[0]}`,
  cmd.bin,
  ...cmd.args,
], {
  cwd: WORK_DIRS[0],
  stdio: "inherit",
  env: { ...process.env, CODEBOX_SANDBOX: "1" },
})

child.on("close", (code: number | null) => {
  rmSync(profilePath, { force: true })
  process.exit(code ?? 0)
})
