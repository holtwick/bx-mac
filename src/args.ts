import process from "node:process"

export const MODES = ["code", "term", "claude", "exec"] as const
export type Mode = (typeof MODES)[number]

export interface Args {
  mode: Mode
  workArgs: string[]
  verbose: boolean
  profileSandbox: boolean
  execCmd: string[]
}

export function parseArgs(): Args {
  const rawArgs = process.argv.slice(2)

  const verbose = rawArgs.includes("--verbose")
  const profileSandbox = rawArgs.includes("--profile-sandbox")
  const positional = rawArgs.filter((a) => !a.startsWith("--"))

  // Split at "--" for exec mode
  const doubleDashIdx = rawArgs.indexOf("--")
  const execCmd = doubleDashIdx >= 0 ? rawArgs.slice(doubleDashIdx + 1) : []
  const beforeDash = doubleDashIdx >= 0
    ? rawArgs.slice(0, doubleDashIdx).filter((a) => !a.startsWith("--"))
    : positional

  // Determine mode and workdirs
  let mode: Mode = "code"
  let workArgs: string[]

  if (beforeDash.length > 0 && MODES.includes(beforeDash[0] as Mode)) {
    mode = beforeDash[0] as Mode
    workArgs = beforeDash.slice(1)
  } else {
    workArgs = beforeDash
  }

  if (workArgs.length === 0) {
    workArgs = ["."]
  }

  if (mode === "exec" && execCmd.length === 0) {
    console.error("sandbox: exec mode requires a command after \"--\"")
    console.error("usage: bx exec [workdir...] -- command [args...]")
    process.exit(1)
  }

  return { mode, workArgs, verbose, profileSandbox, execCmd }
}
