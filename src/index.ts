import { writeFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox, checkWorkDirs, checkAppAlreadyRunning } from "./guards.js"
import { parseArgs } from "./args.js"
import { PROTECTED_DOTDIRS, parseHomeConfig, collectBlockedDirs, collectIgnoredPaths, generateProfile } from "./profile.js"
import { setupVSCodeProfile, buildCommand, bringAppToFront, getActivationCommand, getNestedSandboxWarning } from "./modes.js"
import { loadConfig, getAvailableApps, getValidModes } from "./config.js"
import { printHelp } from "./help.js"
import { printDryRunTree } from "./drytree.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

declare const __VERSION__: string
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"

// --- Early exits: --version / --help (before HOME check) ---

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`bx ${VERSION}`)
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp(VERSION)
  process.exit(0)
}

// --- Require $HOME ---

if (!process.env.HOME) {
  console.error("sandbox: ERROR — $HOME environment variable is not set. Aborting.")
  process.exit(1)
}
const HOME: string = process.env.HOME

// --- Main ---

async function main() {
  const config = loadConfig(HOME)
  const apps = getAvailableApps(config)
  const validModes = getValidModes(apps)
  const { mode, workArgs, verbose, dry, profileSandbox, appArgs, implicit } = parseArgs(validModes)
  const workDirs = workArgs.map((a) => resolve(a))

  if (implicit && !dry) {
    await confirmLaunch(workDirs[0], mode)
  }

  if (!dry) {
    checkOwnSandbox()
    checkVSCodeTerminal()
    checkExternalSandbox()
  }

  checkWorkDirs(workDirs, HOME)
  await checkAppAlreadyRunning(mode, apps)

  if (mode === "code" && profileSandbox) {
    setupVSCodeProfile(HOME)
  }

  // --- Build sandbox profile ---

  const { allowed, readOnly } = parseHomeConfig(HOME, workDirs)
  const allAccessible = new Set([...allowed, ...readOnly])
  const blockedDirs = collectBlockedDirs(HOME, HOME, __dirname, allAccessible)
  const ignoredPaths = collectIgnoredPaths(HOME, workDirs)

  printPolicySummary(mode, workDirs, blockedDirs, ignoredPaths, readOnly)

  const profile = generateProfile(workDirs, blockedDirs, ignoredPaths, [...readOnly])

  if (verbose) {
    console.error("\n--- Generated sandbox profile ---")
    console.error(profile)
    console.error("--- End of profile ---\n")
  }

  if (dry) {
    printDryRunTree({ home: HOME, blockedDirs, ignoredPaths, readOnlyDirs: readOnly, workDirs })
    process.exit(0)
  }

  // --- Launch sandboxed process ---

  const profilePath = join("/tmp", `bx-${process.pid}.sb`)
  writeFileSync(profilePath, profile)

  const cmd = buildCommand(mode, workDirs, HOME, profileSandbox, appArgs, apps)

  const nestedSandboxWarning = getNestedSandboxWarning(mode, apps)
  if (nestedSandboxWarning) {
    console.error(`   ⚠️  ${nestedSandboxWarning}`)
  }

  if (verbose) {
    printLaunchDetails(cmd, workDirs[0], getActivationCommand(mode, apps))
  }

  console.error("")

  const child = spawn("sandbox-exec", [
    "-f", profilePath,
    "-D", `HOME=${HOME}`,
    "-D", `WORK=${workDirs[0]}`,
    cmd.bin,
    ...cmd.args,
  ], {
    cwd: workDirs[0],
    stdio: "inherit",
    env: { ...process.env, CODEBOX_SANDBOX: "1" },
  })

  bringAppToFront(mode, apps)

  child.on("close", (code: number | null) => {
    rmSync(profilePath, { force: true })
    process.exit(code ?? 0)
  })
}

// --- Helpers ---

async function confirmLaunch(workDir: string, mode: string) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((res) => {
    rl.question(`🔒 Open ${workDir} in ${mode}? [Y/n] `, res)
  })
  rl.close()
  if (answer && !answer.match(/^y(es)?$/i)) {
    process.exit(0)
  }
}

// ANSI helpers
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const CYAN = "\x1b[36m"

function printPolicySummary(
  mode: string,
  workDirs: string[],
  blockedDirs: string[],
  ignoredPaths: string[],
  readOnly: Set<string>,
) {
  const dirLabel = workDirs.length === 1 ? workDirs[0] : `${workDirs.length} directories`
  console.error(`\n🔒 ${CYAN}bx${RESET} · ${mode} → ${dirLabel}`)

  const parts: string[] = [
    `${blockedDirs.length} blocked`,
    `${ignoredPaths.length} hidden`,
  ]
  if (readOnly.size > 0) {
    parts.push(`${readOnly.size} read-only`)
  }
  const extraIgnored = ignoredPaths.length - PROTECTED_DOTDIRS.length
  if (extraIgnored > 0) {
    parts.push(`${extraIgnored} from .bxignore`)
  }
  console.error(`   ${DIM}${parts.join(" · ")}${RESET}`)
}

function printLaunchDetails(
  cmd: { bin: string; args: string[] },
  cwd: string,
  activationCmd: { bin: string; args: string[] } | null,
) {
  const quote = (a: string) => JSON.stringify(a)
  console.error(`   ${DIM}bin:  ${cmd.bin}${RESET}`)
  console.error(`   ${DIM}args: ${cmd.args.map(quote).join(" ") || "(none)"}${RESET}`)
  console.error(`   ${DIM}cwd:  ${cwd}${RESET}`)
  if (activationCmd) {
    console.error(`   ${DIM}focus: ${activationCmd.bin} ${activationCmd.args.map(quote).join(" ")}${RESET}`)
  }
}

main()
