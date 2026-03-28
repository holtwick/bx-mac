import { cpSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import type { Mode } from "./args.js"

const VSCODE_APP = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"

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
  mode: Mode,
  workDirs: string[],
  home: string,
  profileSandbox: boolean,
  execCmd: string[],
): Command {
  switch (mode) {
    case "code": {
      const dataDir = join(home, ".vscode-sandbox")
      const args = ["--no-sandbox"]
      if (profileSandbox) {
        args.push("--user-data-dir", join(dataDir, "data"))
        args.push("--extensions-dir", join(dataDir, "extensions"))
      }
      args.push(...workDirs)
      return { bin: VSCODE_APP, args }
    }
    case "term": {
      const shell = process.env.SHELL ?? "/bin/zsh"
      return { bin: shell, args: ["-l"] }
    }
    case "claude": {
      return { bin: "claude", args: [workDirs[0]] }
    }
    case "exec": {
      return { bin: execCmd[0], args: execCmd.slice(1) }
    }
  }
}
