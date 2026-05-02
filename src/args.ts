import process from "node:process"
import { fmt } from "./fmt.js"

export type Subcommand = "launch" | "inspect" | "snapshot" | "diff"

export interface ParsedCommand {
  subcommand: Subcommand
  inspectPath?: string   // only set for "inspect"
  exitCode?: boolean     // only set for "diff"
}

/**
 * Detect subcommand from process.argv[2]. Called before sandbox checks
 * and HOME checks so new subcommands can route without those guards.
 *
 * --help/--version handling at the top level (before main) catches
 * top-level invocations (bx --help, bx --version). Subcommand-level
 * --help (bx inspect --help, bx snapshot --help, bx diff --help) is
 * handled here, since the subcommand keyword is argv[2] and --help is
 * argv[3].
 */
export function parseSubcommand(): ParsedCommand {
  const arg = process.argv[2]

  if (arg === "inspect") {
    const pathArg = process.argv[3]
    if (!pathArg || pathArg === "--help" || pathArg === "-h") {
      if (pathArg === "--help" || pathArg === "-h") {
        console.log(INSPECT_HELP)
        process.exit(0)
      }
      console.error(`\n${fmt.error("inspect requires a path argument")}`)
      console.error(fmt.detail("usage: bx inspect <path>\n"))
      process.exit(1)
    }
    return { subcommand: "inspect", inspectPath: pathArg }
  }

  if (arg === "snapshot") {
    const flag = process.argv[3]
    if (flag === "--help" || flag === "-h") {
      console.log(SNAPSHOT_HELP)
      process.exit(0)
    }
    return { subcommand: "snapshot" }
  }

  if (arg === "diff") {
    const flag = process.argv[3]
    if (flag === "--help" || flag === "-h") {
      console.log(DIFF_HELP)
      process.exit(0)
    }
    const exitCode = process.argv.slice(3).includes("--exit-code")
    return { subcommand: "diff", exitCode }
  }

  return { subcommand: "launch" }
}

const INSPECT_HELP = `bx inspect <path>

Trace effective access for a path across all sandbox layers.

Usage:
  bx inspect <path>

Options:
  -h, --help  Show this help

Output shows each layer's match (if any) and the effective access.`

const SNAPSHOT_HELP = `bx snapshot

Capture current policy to ~/.bxpolicy.snapshot.

Usage:
  bx snapshot

Options:
  -h, --help  Show this help

Overwrites existing snapshot without prompting.`

const DIFF_HELP = `bx diff

Compare current policy against the last snapshot (~/.bxpolicy.snapshot).

Usage:
  bx diff [--exit-code]

Options:
  --exit-code  Exit with code 1 if differences found, 0 if identical
  -h, --help   Show this help`

export interface Args {
  mode: string
  workArgs: string[]
  verbose: boolean
  dry: boolean
  vscodeUser: boolean | string
  background: boolean
  appArgs: string[]
  implicit: boolean
}

/**
 * Parse CLI arguments. `validModes` is the list of recognized mode names
 * (builtin modes + app names from config).
 */
export function parseArgs(validModes: string[]): Args {
  const rawArgs = process.argv.slice(2)

  const verbose = rawArgs.includes("--verbose")
  const dry = rawArgs.includes("--dry")
  const vscodeUser = parseVscodeUserFlag(rawArgs)
  const background = rawArgs.includes("--background")
  const positional = collectPositional(rawArgs)

  // Split at "--" for app arguments (also used by exec mode)
  const doubleDashIdx = rawArgs.indexOf("--")
  const appArgs = doubleDashIdx >= 0 ? rawArgs.slice(doubleDashIdx + 1) : []
  const beforeDash = doubleDashIdx >= 0
    ? collectPositional(rawArgs.slice(0, doubleDashIdx))
    : positional

  // Determine mode and workdirs
  let mode = "code"
  let workArgs: string[]
  let implicitWorkdirs = false

  if (beforeDash.length > 0 && validModes.includes(beforeDash[0])) {
    mode = beforeDash[0]
    workArgs = beforeDash.slice(1)
  } else {
    workArgs = beforeDash
  }

  if (workArgs.length === 0) {
    workArgs = ["."]
    implicitWorkdirs = true
  }

  if (mode === "exec" && appArgs.length === 0) {
    console.error(`\n${fmt.error("exec mode requires a command after \"--\"")}`)
    console.error(fmt.detail("usage: bx exec [workdir...] -- command [args...]\n"))
    process.exit(1)
  }

  return { mode, workArgs, verbose, dry, vscodeUser, background, appArgs, implicit: implicitWorkdirs }
}

function looksLikePath(val: string): boolean {
  return val.includes("/") || val.startsWith("~") || val.startsWith(".")
}

/** Filter positional args, skipping the path value after --vscode-user */
function collectPositional(args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vscode-user" || args[i] === "--vscode-user-data") {
      const next = args[i + 1]
      if (next && looksLikePath(next)) i++
      continue
    }
    if (args[i].startsWith("--")) continue
    result.push(args[i])
  }
  return result
}

function parseVscodeUserFlag(args: string[]): boolean | string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vscode-user" || args[i] === "--vscode-user-data") {
      const next = args[i + 1]
      if (next && looksLikePath(next)) return next
      return true
    }
    if (args[i] === "--vscode-user=false" || args[i] === "--vscode-user-data=false") return false
    const eqMatch = args[i].match(/^--vscode-user=(.+)$/)
    if (eqMatch) return eqMatch[1]
  }
  return false
}
