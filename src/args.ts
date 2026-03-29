import process from "node:process"

export interface Args {
  mode: string
  workArgs: string[]
  verbose: boolean
  dry: boolean
  profileSandbox: boolean
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
  let explicit = false

  if (beforeDash.length > 0 && validModes.includes(beforeDash[0])) {
    mode = beforeDash[0]
    workArgs = beforeDash.slice(1)
    explicit = true
  } else {
    workArgs = beforeDash
  }

  if (workArgs.length === 0) {
    workArgs = ["."]
  } else {
    explicit = true
  }

  if (mode === "exec" && appArgs.length === 0) {
    console.error("sandbox: exec mode requires a command after \"--\"")
    console.error("usage: bx exec [workdir...] -- command [args...]")
    process.exit(1)
  }

  return { mode, workArgs, verbose, dry, profileSandbox, appArgs, implicit: !explicit }
}
