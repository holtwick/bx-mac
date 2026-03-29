import { cpSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import type { AppDefinition } from "./config.js"
import { resolveAppPath, BUILTIN_MODES, type BuiltinMode } from "./config.js"

interface Command {
  bin: string
  args: string[]
}

/**
 * Prepare VSCode isolated profile if --profile-sandbox is set.
 */
export function setupVSCodeProfile(home: string) {
  const dataDir = join(home, ".vscode-sandbox")
  const globalExt = join(home, ".vscode", "extensions")
  const localExt = join(dataDir, "extensions")

  mkdirSync(dataDir, { recursive: true })
  if (!existsSync(localExt) && existsSync(globalExt)) {
    console.error("sandbox: copying extensions from global install...")
    cpSync(globalExt, localExt, { recursive: true })
  }
}

/**
 * Build the command + args to run inside the sandbox for the given mode.
 */
export function buildCommand(
  mode: string,
  workDirs: string[],
  home: string,
  profileSandbox: boolean,
  execCmd: string[],
  apps: Record<string, AppDefinition>,
): Command {
  // Built-in shell modes
  if ((BUILTIN_MODES as readonly string[]).includes(mode)) {
    switch (mode as BuiltinMode) {
      case "term": {
        const shell = process.env.SHELL ?? "/bin/zsh"
        return { bin: shell, args: ["-l"] }
      }
      case "claude": {
        return { bin: "claude", args: [] }
      }
      case "exec": {
        return { bin: execCmd[0], args: execCmd.slice(1) }
      }
    }
  }

  // App mode — resolve from app definitions
  const app = apps[mode]
  if (!app) {
    console.error(`sandbox: unknown mode "${mode}"`)
    process.exit(1)
  }

  const bin = resolveAppPath(app)
  if (!bin) {
    console.error(`sandbox: could not find application for "${mode}"`)
    if (app.bundle) console.error(`  bundle: ${app.bundle}`)
    console.error("  hint: set an explicit path in ~/.bxconfig.toml")
    process.exit(1)
  }

  const args: string[] = []

  // VSCode-specific: profile sandbox flags
  if (mode === "code" && profileSandbox) {
    const dataDir = join(home, ".vscode-sandbox")
    args.push("--user-data-dir", join(dataDir, "data"))
    args.push("--extensions-dir", join(dataDir, "extensions"))
  }

  // App-specific extra args
  if (app.args) args.push(...app.args)

  // Workdirs
  args.push(...workDirs)

  return { bin, args }
}
