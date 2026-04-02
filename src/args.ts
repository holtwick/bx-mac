import process from "node:process"
import { fmt } from "./fmt.js"

export interface Args {
  mode: string
  workArgs: string[]
  verbose: boolean
  dry: boolean
  profile: boolean | string
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
  const profile = parseProfileFlag(rawArgs)
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

  return { mode, workArgs, verbose, dry, profile, background, appArgs, implicit: implicitWorkdirs }
}

function looksLikePath(val: string): boolean {
  return val.includes("/") || val.startsWith("~") || val.startsWith(".")
}

/** Filter positional args, skipping the path value after --profile */
function collectPositional(args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" || args[i] === "--profile-sandbox") {
      const next = args[i + 1]
      if (next && looksLikePath(next)) i++
      continue
    }
    if (args[i].startsWith("--")) continue
    result.push(args[i])
  }
  return result
}

function parseProfileFlag(args: string[]): boolean | string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" || args[i] === "--profile-sandbox") {
      const next = args[i + 1]
      if (next && looksLikePath(next)) return next
      return true
    }
    if (args[i] === "--profile=false" || args[i] === "--profile-sandbox=false") return false
    const eqMatch = args[i].match(/^--profile=(.+)$/)
    if (eqMatch) return eqMatch[1]
  }
  return false
}
