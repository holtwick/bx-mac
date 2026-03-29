import { statSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox, checkWorkDirs } from "./guards.js"
import { parseArgs } from "./args.js"
import { PROTECTED_DOTDIRS, parseHomeConfig, collectBlockedDirs, collectIgnoredPaths, generateProfile } from "./profile.js"
import { setupVSCodeProfile, buildCommand, bringAppToFront, getActivationCommand, getNestedSandboxWarning } from "./modes.js"
import { loadConfig, getAvailableApps, getValidModes } from "./config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

declare const __VERSION__: string
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"

// --- --version and --help ---
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`bx ${VERSION}`)
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const HOME = process.env.HOME!
  const helpConfig = loadConfig(HOME)
  const helpApps = getAvailableApps(helpConfig)
  const appLines = Object.keys(helpApps)
    .map((name) => `  bx ${name} [workdir...] [-- app-args...]${" ".repeat(Math.max(1, 33 - name.length - 33))}${name} (app)`)
    .join("\n")

  console.log(`bx ${VERSION} — launch apps in a macOS sandbox

Usage:
  bx [workdir...]                            VSCode (default)
${appLines}
  bx term [workdir...]                       sandboxed login shell
  bx claude [workdir...]                     Claude Code CLI
  bx exec [workdir...] -- command [args...]  arbitrary command

Options:
  --dry                show what will be protected, don't launch
  --verbose            print the generated sandbox profile
  --profile-sandbox    use an isolated VSCode profile (code mode only)
  -v, --version        show version
  -h, --help           show this help

Configuration:
  ~/.bxconfig.toml     app definitions (TOML):
                         [apps.name]           add a new app
                         bundle = "..."         macOS bundle ID (auto-discovery)
                         binary = "..."         relative path in .app bundle
                         path = "..."           explicit executable path
                         args = ["..."]         extra arguments
                       built-in apps (code, xcode) can be overridden
  ~/.bxignore          sandbox rules (one per line):
                         path         block access (deny)
                         rw:path      allow read-write access
                         ro:path      allow read-only access
  <workdir>/.bxignore  blocked paths in project (.gitignore-style matching)

https://github.com/holtwick/bx-mac`)
  process.exit(0)
}

// --- Load config and parse arguments ---
const HOME = process.env.HOME!
const config = loadConfig(HOME)
const apps = getAvailableApps(config)
const validModes = getValidModes(apps)

const { mode, workArgs, verbose, dry, profileSandbox, appArgs, implicit } = parseArgs(validModes)
const WORK_DIRS = workArgs.map((a) => resolve(a))

function quoteArg(a: string): string {
  return JSON.stringify(a)
}

// --- Confirm when invoked without arguments ---
if (implicit && !dry) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((res) => {
    rl.question(`sandbox: open ${WORK_DIRS[0]} in ${mode}? [Y/n] `, res)
  })
  rl.close()
  if (answer && !answer.match(/^y(es)?$/i)) {
    process.exit(0)
  }
}

// --- Safety guards (skip in dry-run mode) ---
if (!dry) {
  checkOwnSandbox()
  checkVSCodeTerminal()
  checkExternalSandbox()
}

checkWorkDirs(WORK_DIRS, HOME)

// --- VSCode profile setup ---
if (mode === "code" && profileSandbox) {
  setupVSCodeProfile(HOME)
}

// --- Build sandbox profile ---
const { allowed, readOnly } = parseHomeConfig(HOME, WORK_DIRS)
const allAccessible = new Set([...allowed, ...readOnly])
const blockedDirs = collectBlockedDirs(HOME, HOME, __dirname, allAccessible)
const ignoredPaths = collectIgnoredPaths(HOME, WORK_DIRS)

const extraIgnored = ignoredPaths.length - PROTECTED_DOTDIRS.length
if (extraIgnored > 0) {
  console.error(`sandbox: .bxignore hides ${extraIgnored} extra path(s)`)
}
if (readOnly.size > 0) {
  console.error(`sandbox: ${readOnly.size} read-only director${readOnly.size === 1 ? "y" : "ies"}`)
}

const profile = generateProfile(WORK_DIRS, blockedDirs, ignoredPaths, [...readOnly])

const dirLabel = WORK_DIRS.length === 1 ? WORK_DIRS[0] : `${WORK_DIRS.length} directories`
console.error(`sandbox: ${mode} mode, working directory: ${dirLabel}`)
console.error(
  `sandbox: policy summary: workdirs=${WORK_DIRS.length}, blocked-dirs=${blockedDirs.length}, hidden-paths=${ignoredPaths.length}, read-only=${readOnly.size}`,
)

if (verbose) {
  console.error("\n--- Generated sandbox profile ---")
  console.error(profile)
  console.error("--- End of profile ---\n")
}

// --- Dry run ---
if (dry) {
  const R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m"

  type Kind = "blocked" | "ignored" | "read-only" | "workdir"
  const icon = (k: Kind) => k === "read-only" ? `${Y}◉${X}` : k === "workdir" ? `${G}✔${X}` : `${R}✖${X}`
  const tag = (k: Kind) => `${D}${k}${X}`

  // Build a tree: each node has an optional kind (if it's an entry) and children
  interface TreeNode { kind?: Kind; isDir?: boolean; children: Map<string, TreeNode> }
  const root: TreeNode = { children: new Map() }

  function addEntry(absPath: string, kind: Kind, isDir: boolean) {
    const rel = absPath.startsWith(HOME + "/") ? absPath.slice(HOME.length + 1) : absPath
    const parts = rel.split("/")
    let node = root
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map() })
      node = node.children.get(part)!
    }
    node.kind = kind
    node.isDir = isDir
  }

  for (const d of blockedDirs) addEntry(d, "blocked", true)
  for (const p of ignoredPaths) {
    let isDir = false
    try { isDir = statSync(p).isDirectory() } catch { if (p.slice(p.lastIndexOf("/") + 1).startsWith(".")) isDir = true }
    addEntry(p, "ignored", isDir)
  }
  for (const d of readOnly) addEntry(d, "read-only", true)
  for (const d of WORK_DIRS) addEntry(d, "workdir", true)

  function printTree(node: TreeNode, prefix: string) {
    const entries = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (let i = 0; i < entries.length; i++) {
      const [name, child] = entries[i]
      const last = i === entries.length - 1
      const connector = last ? "└── " : "├── "
      const pipe = last ? "    " : "│   "
      if (child.kind) {
        const suffix = child.isDir ? "/" : ""
        console.log(`${prefix}${connector}${icon(child.kind)} ${name}${suffix}  ${tag(child.kind)}`)
      } else {
        console.log(`${prefix}${connector}${C}${name}/${X}`)
      }
      if (child.children.size > 0) {
        printTree(child, prefix + pipe)
      }
    }
  }

  console.log(`\n${C}~/${X}`)
  printTree(root, "")
  console.log(`\n${R}✖${X} = denied  ${Y}◉${X} = read-only  ${G}✔${X} = read-write\n`)
  process.exit(0)
}

// --- Launch ---
const profilePath = join("/tmp", `bx-${process.pid}.sb`)
writeFileSync(profilePath, profile)

const cmd = buildCommand(mode, WORK_DIRS, HOME, profileSandbox, appArgs, apps)
const activationCmd = getActivationCommand(mode, apps)
const nestedSandboxWarning = getNestedSandboxWarning(mode, apps)

if (nestedSandboxWarning) {
  console.error(nestedSandboxWarning)
}

if (verbose) {
  console.error("sandbox: launch details:")
  console.error(`  bin: ${cmd.bin}`)
  console.error(`  args(${cmd.args.length}): ${cmd.args.map(quoteArg).join(" ") || "(none)"}`)
  console.error(`  cwd: ${WORK_DIRS[0]}`)
  if (activationCmd) {
    console.error(`  focus: ${activationCmd.bin} ${activationCmd.args.map(quoteArg).join(" ")}`)
  } else {
    console.error("  focus: (none)")
  }
}

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

bringAppToFront(mode, apps)

child.on("close", (code: number | null) => {
  rmSync(profilePath, { force: true })
  process.exit(code ?? 0)
})
