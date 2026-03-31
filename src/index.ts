import { writeFileSync, rmSync, openSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox, checkWorkDirs, checkAppAlreadyRunning } from "./guards.js"
import { parseArgs } from "./args.js"
import { PROTECTED_DOTDIRS, parseHomeConfig, collectBlockedDirs, collectIgnoredPaths, collectSystemDenyPaths, generateProfile } from "./profile.js"
import { setupVSCodeProfile, buildCommand, bringAppToFront, getActivationCommand, getNestedSandboxWarning } from "./modes.js"
import { loadConfig, getAvailableApps, getValidModes } from "./config.js"
import { printHelp } from "./help.js"
import { printDryRunTree } from "./drytree.js"
import { fmt } from "./fmt.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

import pkg from "../package.json" with { type: "json" }
const VERSION = pkg.version

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
  console.error(`\n${fmt.error("$HOME environment variable is not set")}\n`)
  process.exit(1)
}
const HOME: string = process.env.HOME

// --- Main ---

async function main() {
  const config = loadConfig(HOME)
  const apps = getAvailableApps(config)
  const validModes = getValidModes(apps)
  const { mode, workArgs, verbose, dry, profileSandbox, background: backgroundFlag, appArgs, implicit } = parseArgs(validModes)

  // Use preconfigured workdirs from config if none given on CLI
  const app = apps[mode]
  const effectiveWorkArgs = implicit && app?.paths?.length ? app.paths : workArgs
  const workDirs = effectiveWorkArgs.map((a) => resolve(a.replace(/^~\//, HOME + "/")))

  if (implicit && !app?.paths?.length) {
    if (workDirs.some((d) => d === HOME)) {
      console.error(`\n${fmt.error("no working directory specified and current directory is $HOME")}\n`)
      console.error(fmt.detail(`Usage:  bx ${mode} <workdir>`))
      console.error(fmt.detail(`Config: set default paths in ~/.bxconfig.toml:\n`))
      console.error(fmt.detail(`[${mode}]`))
      console.error(fmt.detail(`paths = ["~/work/my-project"]\n`))
      process.exit(1)
    }
    if (!dry) {
      await confirmLaunch(workDirs[0], mode)
    }
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

  const profile = generateProfile(workDirs, blockedDirs, ignoredPaths, [...readOnly], HOME)

  if (verbose) {
    console.error("\n--- Generated sandbox profile ---")
    console.error(profile)
    console.error("--- End of profile ---\n")
  }

  if (dry) {
    const systemDenyPaths = collectSystemDenyPaths(HOME)
    printDryRunTree({ home: HOME, blockedDirs, ignoredPaths, readOnlyDirs: readOnly, workDirs, systemDenyPaths })
    process.exit(0)
  }

  // --- Launch sandboxed process ---

  const profilePath = join("/tmp", `bx-${process.pid}.sb`)
  writeFileSync(profilePath, profile)

  const cmd = buildCommand(mode, workDirs, HOME, profileSandbox, appArgs, apps)
  const background = backgroundFlag || app?.background === true

  const nestedSandboxWarning = getNestedSandboxWarning(mode, apps)
  if (nestedSandboxWarning) {
    console.error(fmt.detail(nestedSandboxWarning))
  }

  if (verbose) {
    printLaunchDetails(cmd, workDirs[0], getActivationCommand(mode, apps))
  }

  console.error("")

  if (background) {
    const logPath = join("/tmp", `bx-${process.pid}.log`)
    const logFd = openSync(logPath, "a")

    const child = spawn("sandbox-exec", [
      "-f", profilePath,
      "-D", `HOME=${HOME}`,
      "-D", `WORK=${workDirs[0]}`,
      cmd.bin,
      ...cmd.args,
    ], {
      cwd: workDirs[0],
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: { ...process.env, CODEBOX_SANDBOX: "1" },
    })

    child.unref()
    bringAppToFront(mode, apps)

    console.error(fmt.info(`running in background (pid ${child.pid})`))
    console.error(fmt.detail(`log: ${logPath}`))
    console.error(fmt.detail(`sandbox profile: ${profilePath} (kept until process exits)`))
    process.exit(0)
  }

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
    rl.question(`${fmt.info(`open ${workDir} in ${mode}?`)} [Y/n] `, res)
  })
  rl.close()
  if (answer && !answer.match(/^y(es)?$/i)) {
    process.exit(0)
  }
}

function printPolicySummary(
  mode: string,
  workDirs: string[],
  blockedDirs: string[],
  ignoredPaths: string[],
  readOnly: Set<string>,
) {
  const dirLabel = workDirs.length === 1 ? workDirs[0] : `${workDirs.length} directories`
  console.error(`\n${fmt.info(`${mode} → ${dirLabel}`)}`)

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
  console.error(fmt.detail(parts.join(" · ")))
}

function printLaunchDetails(
  cmd: { bin: string; args: string[] },
  cwd: string,
  activationCmd: { bin: string; args: string[] } | null,
) {
  const quote = (a: string) => JSON.stringify(a)
  console.error(fmt.detail(`bin:  ${cmd.bin}`))
  console.error(fmt.detail(`args: ${cmd.args.map(quote).join(" ") || "(none)"}`))
  console.error(fmt.detail(`cwd:  ${cwd}`))
  if (activationCmd) {
    console.error(fmt.detail(`focus: ${activationCmd.bin} ${activationCmd.args.map(quote).join(" ")}`))
  }
}

main()
