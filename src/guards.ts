import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import process from "node:process"
import type { AppDefinition } from "./config.js"
import { BUILTIN_MODES } from "./config.js"

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
 * Warn if the target app is already running — the new workspace will open
 * in the existing (unsandboxed) instance, bypassing our sandbox profile.
 */
export async function checkAppAlreadyRunning(mode: string, apps: Record<string, AppDefinition>) {
  if ((BUILTIN_MODES as readonly string[]).includes(mode)) return

  const app = apps[mode]
  if (!app?.bundle) return

  let running = false
  try {
    const list = execFileSync("lsappinfo", ["list"], {
      encoding: "utf-8",
      timeout: 3000,
    })
    running = list.includes(`bundleID="${app.bundle}"`)
  } catch {
    // lsappinfo failed — skip check silently
    return
  }

  if (!running) return

  console.error(`\n   ⚠️  "${mode}" is already running.`)
  console.error(`      The workspace will open in the EXISTING instance — sandbox restrictions will NOT apply.`)
  if (mode === "code") {
    console.error(`      Quit the app first, or use --profile-sandbox for an isolated instance.`)
  } else {
    console.error(`      Quit the app first to ensure sandbox protection.`)
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((res) => {
    rl.question("      Continue without sandbox? [y/N] ", res)
  })
  rl.close()

  if (!answer.match(/^y(es)?$/i)) {
    process.exit(0)
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
