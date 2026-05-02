import { writeFileSync, rmSync, openSync, closeSync, mkdtempSync, realpathSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawn, execSync } from "node:child_process"
import { createInterface } from "node:readline"
import process from "node:process"
import { checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox, checkWorkDirs, checkAppAlreadyRunning } from "./guards.js"
import { parseArgs, parseSubcommand } from "./args.js"
import { PROTECTED_DOTDIRS, PROTECTED_HOME_DOTFILES, PROTECTED_LIBRARY_DIRS, parseHomeConfig, collectBlockedDirs, collectIgnoredPaths, collectReadOnlyDotfiles, collectSystemDenyPaths, generateProfile } from "./profile.js"
import { setupVSCodeProfile, buildCommand, bringAppToFront, getActivationCommand, getNestedSandboxWarning } from "./modes.js"
import { loadConfig, getAvailableApps, getValidModes } from "./config.js"
import { expandGlobs } from "./paths.js"
import { printHelp } from "./help.js"
import { printDryRunTree } from "./drytree.js"
import { fmt } from "./fmt.js"
import { tracePath } from "./tracer.js"
import { buildSnapshot, writeSnapshot, readSnapshot, diffSnapshots, formatDiff } from "./snapshot.js"
import type { Snapshot } from "./snapshot.js"

// @ts-ignore - bundled by rolldown, replaced at build time
import pkg from "../package.json" with { type: "json" }
const VERSION: string = pkg.version

import { fileURLToPath } from "node:url"
const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Early exits: --version / --help (before HOME check) ---

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`bx ${VERSION}`)
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  // For subcommand-level --help, delegate to parseSubcommand which
  // prints subcommand-specific help. Top-level --help uses printHelp.
  const sub = process.argv[2]
  if (sub === "inspect" || sub === "snapshot" || sub === "diff") {
    parseSubcommand() // handles --help internally and exits
  }
  printHelp(VERSION)
  process.exit(0)
}

if (process.argv.includes("--docs")) {
  execSync("open https://github.com/holtwick/bx-mac")
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
  // Sandbox checks must run before any subcommand (including inspect, snapshot, diff).
  // If we're inside an existing sandbox, all filesystem access is unreliable --
  // statSync on protected paths fails with EPERM, causing inspect to silently report
  // BLOCKED paths as nonexistent.
  checkOwnSandbox()
  checkExternalSandbox()

  const parsed = parseSubcommand()

  if (parsed.subcommand === "inspect") {
    const targetPath = resolve(parsed.inspectPath!)
    const { allowed, readOnly } = parseHomeConfig(HOME, [])
    const config = loadConfig(HOME)
    const apps = getAvailableApps(config)

    // Collect workdirs from every app that has default paths configured.
    // For inspect, we don't need a specific mode — just any configured workdirs
    // to check workdir membership and workdir .bxignore layers.
    const workDirs: string[] = []
    for (const app of Object.values(apps)) {
      if (app.paths?.length) {
        for (const p of app.paths) {
          const expanded = expandGlobs([p], HOME)
          for (const e of expanded) {
            try { workDirs.push(realpathSync(resolve(e))) } catch { /* skip */ }
          }
        }
      }
    }

    const matches = tracePath(targetPath, HOME, workDirs, { allowed, readOnly })

    // Check if path exists on disk
    let nonexistent = false
    try { statSync(targetPath) } catch { nonexistent = true }

    console.log(`\nEvaluating: ${targetPath}`)
    if (nonexistent) {
      console.log(`Note: path does not exist on disk\n`)
    }

    for (const match of matches) {
      const accessLabel = match.access === "allowed"
        ? "ALLOWED"
        : match.access === "read-only"
          ? "READ-ONLY"
          : "BLOCKED"
      const layerNum = (matches.indexOf(match) + 1).toString().padStart(2, " ")
      const layerDisplay = `Layer ${layerNum}: ${match.layer}`
      console.log(`${layerDisplay.padEnd(58)}→ ${accessLabel}`)
      if (match.source) {
        console.log(`         source: ${match.source.value}`)
      }
    }

    // Effective access: first match is highest priority
    const effective = matches[0]
    const effLabel = effective.access === "allowed"
      ? "ALLOWED"
      : effective.access === "read-only"
        ? "READ-ONLY"
        : "BLOCKED"

    if (effective.layer === "default allow" && matches.length === 1) {
      console.log(`\nEffective: ${effLabel} (no rules match)\n`)
    } else {
      console.log(`\nEffective: ${effLabel} (by ${effective.layer})\n`)
    }

    process.exit(0)
  }

  if (parsed.subcommand === "snapshot") {
    const config = loadConfig(HOME)
    const apps = getAvailableApps(config)

    // Collect workdirs from every configured app
    const workDirs: string[] = []
    for (const app of Object.values(apps)) {
      if (app.paths?.length) {
        for (const p of app.paths) {
          const expanded = expandGlobs([p], HOME)
          for (const e of expanded) {
            try { workDirs.push(realpathSync(resolve(e))) } catch { /* skip */ }
          }
        }
      }
    }

    const snapshot = buildSnapshot(HOME, workDirs)
    writeSnapshot(snapshot)
    console.error(`\n${fmt.info("snapshot saved to ~/.bxpolicy.snapshot")}`)
    console.error(fmt.detail(`${snapshot.entries.length} entries`))
    process.exit(0)
  }

  if (parsed.subcommand === "diff") {
    // Read existing snapshot
    let oldSnapshot: Snapshot
    try {
      oldSnapshot = readSnapshot(HOME)
    } catch (err: any) {
      console.error(`\n${fmt.error("no snapshot found")}`)
      console.error(fmt.detail("run 'bx snapshot' first\n"))
      process.exit(1)
    }

    // Build current snapshot
    const diffConfig = loadConfig(HOME)
    const diffApps = getAvailableApps(diffConfig)
    const diffWorkDirs: string[] = []
    for (const app of Object.values(diffApps)) {
      if (app.paths?.length) {
        for (const p of app.paths) {
          const expanded = expandGlobs([p], HOME)
          for (const e of expanded) {
            try { diffWorkDirs.push(realpathSync(resolve(e))) } catch { /* skip */ }
          }
        }
      }
    }

    const currentSnapshot = buildSnapshot(HOME, diffWorkDirs)

    // Diff
    const result = diffSnapshots(oldSnapshot, currentSnapshot)
    const output = formatDiff(result)
    console.log(output)

    // --exit-code logic
    if (parsed.exitCode && (result.added.length > 0 || result.removed.length > 0 || result.changed.length > 0)) {
      process.exit(1)
    }
    process.exit(0)
  }

  // --- launch (existing flow) ---

  const config = loadConfig(HOME)
  const apps = getAvailableApps(config)
  const validModes = getValidModes(apps)
  const { mode, workArgs, verbose, dry, vscodeUser: vscodeUserFlag, background: backgroundFlag, appArgs, implicit } = parseArgs(validModes)

  // Use preconfigured workdirs from config if none given on CLI
  const app = apps[mode]
  const effectiveWorkArgs = implicit && app?.paths?.length ? app.paths : workArgs
  const expanded = expandGlobs(effectiveWorkArgs, HOME)
  const workDirs = expanded.map((a) => realpathSync(resolve(a)))

  if (workDirs.length === 0) {
    console.error(`\n${fmt.error("no matching working directories found")}\n`)
    process.exit(1)
  }

  if (implicit && !app?.paths?.length) {
    if (workDirs.some((d) => d === HOME)) {
      console.error(`\n${fmt.error("no working directory specified and current directory is $HOME")}\n`)
      console.error(fmt.detail(`Usage:  bx ${mode} <workdir>`))
      console.error(fmt.detail(`Config: set default paths in ~/.bxconfig.toml:\n`))
      console.error(fmt.detail(`[${mode}]`))
      console.error(fmt.detail(`paths = ["~/work/my-project"]\n`))
      console.error(fmt.detail(`Run bx --help for more info.`))
      console.error(fmt.detail(`Docs: https://github.com/holtwick/bx-mac\n`))
      process.exit(1)
    }
    if (!dry) {
      await confirmLaunch(workDirs[0], mode)
    }
  }

  if (!dry) {
    checkVSCodeTerminal()
  }

  checkWorkDirs(workDirs, HOME)
  await checkAppAlreadyRunning(mode, apps)

  // Merge vscode-user: CLI flag overrides config value
  const profileSandbox = vscodeUserFlag !== false ? vscodeUserFlag : app?.profile ?? false

  if (profileSandbox) {
    await setupVSCodeProfile(HOME, profileSandbox)
  }

  // --- Build sandbox profile ---

  const { allowed, readOnly } = parseHomeConfig(HOME, workDirs)
  const allAccessible = new Set([...allowed, ...readOnly])
  warnDangerousOverrides(HOME, allAccessible)
  const blockedDirs = collectBlockedDirs(HOME, HOME, __dirname, allAccessible)
  const ignoredPaths = collectIgnoredPaths(HOME, workDirs, allAccessible, readOnly)
  const readOnlyDotfiles = collectReadOnlyDotfiles(HOME, allAccessible)

  printPolicySummary(mode, workDirs, blockedDirs, ignoredPaths, readOnly)

  const profile = generateProfile(workDirs, blockedDirs, ignoredPaths, [...readOnly], HOME, readOnlyDotfiles)

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

  const tmpDir = mkdtempSync(join("/tmp", "bx-"))
  const profilePath = join(tmpDir, "profile.sb")
  writeFileSync(profilePath, profile, { mode: 0o600 })

  const cmd = buildCommand(mode, workDirs, HOME, profileSandbox, appArgs, apps)
  const background = backgroundFlag || app?.background === true

  const nestedSandboxWarning = getNestedSandboxWarning(mode, apps)
  if (nestedSandboxWarning) {
    console.error(fmt.detail(nestedSandboxWarning))
  }

  printLaunchDetails(cmd, workDirs[0])

  if (verbose) {
    const activationCmd = getActivationCommand(mode, apps)
    if (activationCmd) {
      const quote = (a: string) => JSON.stringify(a)
      console.error(fmt.detail(`focus: ${activationCmd.bin} ${activationCmd.args.map(quote).join(" ")}`))
    }
  }

  console.error("")

  if (background) {
    const logPath = join(tmpDir, "bx.log")
    const logFd = openSync(logPath, "a", 0o600)

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

    child.on("error", (err) => {
      console.error(fmt.error(`failed to start sandbox: ${err.message}`))
      process.exit(1)
    })

    child.unref()
    closeSync(logFd)
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

  const cleanup = () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { } }
  process.on("exit", cleanup)

  child.on("error", (err) => {
    console.error(fmt.error(`failed to start sandbox: ${err.message}`))
    process.exit(1)
  })

  bringAppToFront(mode, apps)

  child.on("close", (code: number | null) => {
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
  const extraIgnored = ignoredPaths.length - PROTECTED_DOTDIRS.length - PROTECTED_HOME_DOTFILES.length
  if (extraIgnored > 0) {
    parts.push(`${extraIgnored} from .bxignore`)
  }
  console.error(fmt.detail(parts.join(" · ")))
}

function warnDangerousOverrides(home: string, accessible: Set<string>) {
  const sensitive = [
    ...PROTECTED_DOTDIRS.map((d) => join(home, d)),
    ...PROTECTED_HOME_DOTFILES.map((f) => join(home, f)),
    ...PROTECTED_LIBRARY_DIRS.map((d) => join(home, "Library", d)),
  ]
  const hits = sensitive.filter((p) => accessible.has(p))
  for (const p of hits) {
    console.error(fmt.detail(`warning: ~/.bxignore override exposes built-in protected path ${p}`))
  }
}

function printLaunchDetails(
  cmd: { bin: string; args: string[] },
  cwd: string,
) {
  const quote = (a: string) => JSON.stringify(a)
  console.error(fmt.detail(`bin:  ${cmd.bin}`))
  console.error(fmt.detail(`args: ${cmd.args.map(quote).join(" ") || "(none)"}`))
  console.error(fmt.detail(`cwd:  ${cwd}`))
}

main()
