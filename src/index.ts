import { accessSync, constants, cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import process from "node:process"

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

// Guard: detect if launched from inside a sandboxed VSCode instance
if (process.env.CODEBOX_SANDBOX === "1") {
  console.error("sandbox: ERROR — already running inside a bx sandbox.")
  console.error("sandbox: Nesting sandbox-exec causes silent failures. Aborting.")
  process.exit(1)
}

// Guard: warn if launched from a VSCode terminal (likely not intended)
if (process.env.VSCODE_PID) {
  console.error("sandbox: WARNING — running from inside a VSCode terminal.")
  console.error("sandbox: This will launch a *new* instance in a sandbox.")
  console.error("sandbox: The current VSCode instance will NOT be sandboxed.")
}

// Detect if we're inside an unknown sandbox by probing well-known
// directories that exist on every Mac but would be blocked.
function isAlreadySandboxed(): boolean {
  const probes = ["Documents", "Desktop", "Downloads"]
  for (const dir of probes) {
    const target = join(process.env.HOME!, dir)
    try {
      accessSync(target, constants.R_OK)
    } catch (e: any) {
      if (e.code === "EPERM") return true
    }
  }
  return false
}

if (isAlreadySandboxed()) {
  console.error("sandbox: ERROR — already running inside a sandbox!")
  console.error("sandbox: Nesting sandbox-exec may cause silent failures. Aborting.")
  process.exit(1)
}

// --- Argument parsing ---
const MODES = ["code", "term", "claude", "exec"] as const
type Mode = (typeof MODES)[number]

const rawArgs = process.argv.slice(2)

// Extract flags
const verbose = rawArgs.includes("--verbose")
const profileSandbox = rawArgs.includes("--profile-sandbox")
const positional = rawArgs.filter((a: string) => !a.startsWith("--"))

// Split at "--" for exec mode
const doubleDashIdx = rawArgs.indexOf("--")
const execCmd = doubleDashIdx >= 0 ? rawArgs.slice(doubleDashIdx + 1) : []
const beforeDash = doubleDashIdx >= 0
  ? rawArgs.slice(0, doubleDashIdx).filter((a: string) => !a.startsWith("--"))
  : positional

// Determine mode and workdir
let mode: Mode = "code"
let workArg = "."

if (beforeDash.length > 0 && MODES.includes(beforeDash[0] as Mode)) {
  mode = beforeDash[0] as Mode
  workArg = beforeDash[1] ?? "."
} else if (beforeDash.length > 0) {
  workArg = beforeDash[0]
}

if (mode === "exec" && execCmd.length === 0) {
  console.error("sandbox: exec mode requires a command after \"--\"")
  console.error("usage: bx exec [workdir] -- command [args...]")
  process.exit(1)
}

const HOME = process.env.HOME!
const SCRIPT_DIR = __dirname
const WORK_DIR = resolve(workArg)

// --- Parse ~/.bxallow ---
const allowedDirs = new Set([WORK_DIR])
const sandboxAllowPath = join(HOME, ".bxallow")
if (existsSync(sandboxAllowPath)) {
  for (const raw of readFileSync(sandboxAllowPath, "utf-8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const absolute = resolve(HOME, line)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      allowedDirs.add(absolute)
    }
  }
}

// --- VSCode-specific setup ---
const VSCODE_APP = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
const VSCODE_DATA = join(HOME, ".vscode-sandbox")
const VSCODE_EXTENSIONS_GLOBAL = join(HOME, ".vscode", "extensions")
const VSCODE_EXTENSIONS_LOCAL = join(VSCODE_DATA, "extensions")

if (mode === "code" && profileSandbox) {
  mkdirSync(VSCODE_DATA, { recursive: true })
  if (!existsSync(VSCODE_EXTENSIONS_LOCAL) && existsSync(VSCODE_EXTENSIONS_GLOBAL)) {
    console.error("sandbox: copying extensions from global install...")
    cpSync(VSCODE_EXTENSIONS_GLOBAL, VSCODE_EXTENSIONS_LOCAL, { recursive: true })
  }
}

// --- Collect directories to block ---
// Since SBPL deny always wins over allow, we must never deny a parent
// of the working directory. Instead, when WORK_DIR is inside a dir,
// we descend into that dir and block its siblings individually.
function collectBlockedDirs(parentDir: string): string[] {
  const blocked: string[] = []

  for (const name of readdirSync(parentDir)) {
    if (name.startsWith(".")) continue

    const fullPath = join(parentDir, name)

    // Skip non-directories
    if (!statSync(fullPath).isDirectory()) continue

    // Skip Library at the top level
    if (parentDir === HOME && name === "Library") continue

    // Skip if this tooling repo lives inside it
    if (SCRIPT_DIR.startsWith(fullPath + "/") || SCRIPT_DIR === fullPath) continue

    // If this dir is explicitly allowed, skip it
    if (allowedDirs.has(fullPath)) continue

    // If an allowed dir is inside this dir, descend and block siblings
    const hasAllowedChild = [...allowedDirs].some(
      (d) => d.startsWith(fullPath + "/")
    )
    if (hasAllowedChild) {
      blocked.push(...collectBlockedDirs(fullPath))
      continue
    }

    blocked.push(fullPath)
  }

  return blocked
}

const blockedDirs = collectBlockedDirs(HOME)

// --- Parse .bxignore files ---
const PROTECTED_DOTDIRS = [
  ".Trash",
  ".ssh",
  ".gnupg",
  ".docker",
  ".zsh_sessions",
  ".cargo",
  ".gradle",
  ".gem",
]
const ignoredPaths: string[] = PROTECTED_DOTDIRS.map((d) => join(HOME, d))

function parseSandboxIgnore(filePath: string, baseDir: string) {
  if (!existsSync(filePath)) return
  for (const raw of readFileSync(filePath, "utf-8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const matches = globSync(line, { cwd: baseDir })
    for (const match of matches) {
      ignoredPaths.push(resolve(baseDir, match))
    }
  }
}

parseSandboxIgnore(join(HOME, ".bxignore"), HOME)
parseSandboxIgnore(join(WORK_DIR, ".bxignore"), WORK_DIR)

const extraIgnored = ignoredPaths.length - PROTECTED_DOTDIRS.length
if (extraIgnored > 0) {
  console.error(`sandbox: .bxignore hides ${extraIgnored} extra path(s)`)
}

// --- Build sandbox profile ---
const denyRules = blockedDirs
  .map((dir) => `  (subpath "${dir}")`)
  .join("\n")

const profile = `; Auto-generated sandbox profile
; Working directory: ${WORK_DIR}

(version 1)
(allow default)

; Blocked directories (auto-generated from $HOME contents)
(deny file*
${denyRules}
)

${ignoredPaths.length > 0 ? `
; Hidden paths from .bxignore
(deny file*
${ignoredPaths.map((p) => {
  const isDir = existsSync(p) && statSync(p).isDirectory()
  return isDir ? `  (subpath "${p}")` : `  (literal "${p}")`
}).join("\n")}
)
` : ""}
`

// Write profile to temp file
const profilePath = join("/tmp", `bx-${process.pid}.sb`)
writeFileSync(profilePath, profile)

console.error(`sandbox: ${mode} mode, working directory: ${WORK_DIR}`)

if (verbose) {
  console.error("\n--- Generated sandbox profile ---")
  console.error(profile)
  console.error("--- End of profile ---\n")
}

// --- Build the command to run inside the sandbox ---
function buildCommand(): { bin: string; args: string[] } {
  switch (mode) {
    case "code": {
      const args = ["--no-sandbox"]
      if (profileSandbox) {
        args.push("--user-data-dir", join(VSCODE_DATA, "data"))
        args.push("--extensions-dir", VSCODE_EXTENSIONS_LOCAL)
      }
      args.push(WORK_DIR)
      return { bin: VSCODE_APP, args }
    }
    case "term": {
      const shell = process.env.SHELL ?? "/bin/zsh"
      return { bin: shell, args: ["-l"] }
    }
    case "claude": {
      return { bin: "claude", args: [WORK_DIR] }
    }
    case "exec": {
      return { bin: execCmd[0], args: execCmd.slice(1) }
    }
  }
}

const cmd = buildCommand()

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

child.on("close", (code: any) => {
  rmSync(profilePath, { force: true })
  process.exit(code ?? 0)
})
