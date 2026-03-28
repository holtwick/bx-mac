import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import process from "node:process"

/**
 * Abort if we're already inside a bx sandbox (env var set by us).
 */
export function checkOwnSandbox() {
  if (process.env.CODEBOX_SANDBOX === "1") {
    console.error("sandbox: ERROR — already running inside a bx sandbox.")
    console.error("sandbox: Nesting sandbox-exec causes silent failures. Aborting.")
    process.exit(1)
  }
}

/**
 * Warn if launched from inside a VSCode terminal.
 */
export function checkVSCodeTerminal() {
  if (process.env.VSCODE_PID) {
    console.error("sandbox: WARNING — running from inside a VSCode terminal.")
    console.error("sandbox: This will launch a *new* instance in a sandbox.")
    console.error("sandbox: The current VSCode instance will NOT be sandboxed.")
  }
}

/**
 * Abort if any workdir IS $HOME or is not inside $HOME.
 */
export function checkWorkDirs(workDirs: string[], home: string) {
  for (const dir of workDirs) {
    if (dir === home) {
      console.error("sandbox: ERROR — working directory cannot be $HOME itself.")
      console.error("sandbox: Sandboxing your entire home directory is not supported. Aborting.")
      process.exit(1)
    }
    if (!dir.startsWith(home + "/")) {
      console.error(`sandbox: ERROR — working directory is outside $HOME: ${dir}`)
      console.error("sandbox: Only directories inside $HOME are supported. Aborting.")
      process.exit(1)
    }
  }
}

/**
 * Detect if we're inside an unknown sandbox by probing well-known
 * directories that exist on every Mac but would be blocked.
 */
export function checkExternalSandbox() {
  const probes = ["Documents", "Desktop", "Downloads"]
  for (const dir of probes) {
    const target = join(process.env.HOME!, dir)
    try {
      accessSync(target, constants.R_OK)
    } catch (e: any) {
      if (e.code === "EPERM") {
        console.error("sandbox: ERROR — already running inside a sandbox!")
        console.error("sandbox: Nesting sandbox-exec may cause silent failures. Aborting.")
        process.exit(1)
      }
    }
  }
}
