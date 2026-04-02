import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import process from "node:process"
import type { AppDefinition } from "./config.js"
import { BUILTIN_MODES } from "./config.js"
import { isSelfProtected } from "./profile.js"
import { fmt } from "./fmt.js"

/**
 * Abort if we're already inside a bx sandbox (env var set by us).
 */
export function checkOwnSandbox() {
  if (process.env.CODEBOX_SANDBOX === "1") {
    console.error(`\n${fmt.error("already running inside a bx sandbox")}`)
    console.error(fmt.detail("nesting sandbox-exec causes silent failures\n"))
    process.exit(1)
  }
}

/**
 * Warn if launched from inside a VSCode terminal.
 */
export function checkVSCodeTerminal() {
  if (process.env.VSCODE_PID) {
    console.error(`\n${fmt.warn("running from inside a VSCode terminal")}`)
    console.error(fmt.detail("this will launch a *new* instance in a sandbox"))
    console.error(fmt.detail("the current VSCode instance will NOT be sandboxed"))
  }
}

/**
 * Abort if any workdir IS $HOME or is not inside $HOME.
 */
export function checkWorkDirs(workDirs: string[], home: string) {
  for (const dir of workDirs) {
    if (dir === home) {
      console.error(`\n${fmt.error("working directory cannot be $HOME itself")}`)
      console.error(fmt.detail("sandboxing your entire home directory is not supported\n"))
      process.exit(1)
    }
    if (!dir.startsWith(home + "/")) {
      console.error(`\n${fmt.error(`working directory is outside $HOME: ${dir}`)}`)
      console.error(fmt.detail("only directories inside $HOME are supported\n"))
      process.exit(1)
    }
    if (isSelfProtected(dir)) {
      console.error(`\n${fmt.error(`working directory is self-protected: ${dir}`)}`)
      console.error(fmt.detail("remove .bxprotect or '/' from .bxignore to allow access\n"))
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

  let appName = mode
  try {
    const list = execFileSync("lsappinfo", ["list"], {
      encoding: "utf-8",
      timeout: 3000,
    })
    if (!list.includes(`bundleID="${app.bundle}"`)) return
    // lsappinfo format: line N has '"AppName" ASN:...', line N+1 has '    bundleID="..."'
    const idx = list.indexOf(`bundleID="${app.bundle}"`)
    const bundleLine = list.lastIndexOf("\n", idx)
    const prevLine = list.lastIndexOf("\n", bundleLine - 1)
    const entryLine = list.slice(prevLine === -1 ? 0 : prevLine, bundleLine)
    const nameMatch = entryLine.match(/"([^"]+)"/)
    if (nameMatch) appName = nameMatch[1]
  } catch {
    // lsappinfo failed — skip check silently
    return
  }

  console.error(`\n${fmt.warn(`"${appName}" is already running`)}`)
  console.error(fmt.detail("the workspace will open in the EXISTING instance — sandbox will NOT apply"))
  if (mode === "code") {
    console.error(fmt.detail("quit the app first, or use --vscode-user for an isolated instance"))
  } else {
    console.error(fmt.detail("quit the app first to ensure sandbox protection"))
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((res) => {
    rl.question(`   continue with existing instance? [y/N]`, res)
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
        console.error(`\n${fmt.error("already running inside a sandbox")}`)
        console.error(fmt.detail("nesting sandbox-exec may cause silent failures\n"))
        process.exit(1)
      }
    }
  }
}
