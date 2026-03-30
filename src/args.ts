import process from "node:process"
import { fmt } from "./fmt.js"

export interface Args {
  mode: string
  workArgs: string[]
  verbose: boolean
  dry: boolean
  profileSandbox: boolean
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
  const profileSandbox = rawArgs.includes("--profile-sandbox")
  const background = rawArgs.includes("--background")
  const positional = rawArgs.filter((a) => !a.startsWith("--"))

  // Split at "--" for app arguments (also used by exec mode)
  const doubleDashIdx = rawArgs.indexOf("--")
  const appArgs = doubleDashIdx >= 0 ? rawArgs.slice(doubleDashIdx + 1) : []
  const beforeDash = doubleDashIdx >= 0
    ? rawArgs.slice(0, doubleDashIdx).filter((a) => !a.startsWith("--"))
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

  return { mode, workArgs, verbose, dry, profileSandbox, background, appArgs, implicit: implicitWorkdirs }
}
