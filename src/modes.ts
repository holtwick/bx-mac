import { cpSync, existsSync, mkdirSync } from "node:fs"
import { join, basename, resolve } from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import process from "node:process"
import type { AppDefinition } from "./config.js"
import { resolveAppPath, BUILTIN_MODES, type BuiltinMode } from "./config.js"
import { fmt } from "./fmt.js"

export interface Command {
  bin: string
  args: string[]
}

function isBuiltinMode(mode: string): mode is BuiltinMode {
  return (BUILTIN_MODES as readonly string[]).includes(mode)
}

function getPassPaths(app: AppDefinition, workDirs: string[], home: string): string[] {
  const val = app.passPaths
  if (val === false) return []
  if (typeof val === "number") return workDirs.slice(0, val)
  if (Array.isArray(val)) return val.map((p) => p.replace(/^~\//, home + "/"))
  return workDirs
}

// --- .app bundle path helpers ---

function appBundleFromPath(path: string): string | null {
  if (path.endsWith(".app")) return path
  const idx = path.indexOf(".app/")
  if (idx < 0) return null
  return path.slice(0, idx + ".app".length)
}

function executableFromBundle(bundlePath: string, app: AppDefinition): string {
  if (!bundlePath.endsWith(".app")) return bundlePath
  if (app.binary) return join(bundlePath, app.binary)
  const appName = basename(bundlePath, ".app")
  return join(bundlePath, "Contents", "MacOS", appName)
}

// --- Entitlement detection ---

const SANDBOX_KEY = "com.apple.security.app-sandbox"

export function hasAppSandboxEntitlement(entitlements: string): boolean {
  // XML plist: <key>...app-sandbox</key><true/>
  const xmlTrue = new RegExp(`<key>\\s*${SANDBOX_KEY.replace(/\./g, "\\.")}\\s*</key>\\s*<true\\s*/>`, "i")
  if (xmlTrue.test(entitlements)) return true

  const xmlFalse = new RegExp(`<key>\\s*${SANDBOX_KEY.replace(/\./g, "\\.")}\\s*</key>\\s*<false\\s*/>`, "i")
  if (xmlFalse.test(entitlements)) return false

  // Key-value style: com.apple.security.app-sandbox = true
  const kvTrue = new RegExp(`${SANDBOX_KEY.replace(/\./g, "\\.")}\\s*[=:]\\s*(1|true)`, "i")
  return kvTrue.test(entitlements)
}

// --- Public API ---

export function resolveProfileDir(home: string, profile: boolean | string): string {
  if (typeof profile === "string") return resolve(profile.replace(/^~\//, home + "/"))
  return join(home, ".vscode-sandbox")
}

export async function setupVSCodeProfile(home: string, profile: boolean | string) {
  const dataDir = resolveProfileDir(home, profile)
  const globalExt = join(home, ".vscode", "extensions")
  const localExt = join(dataDir, "extensions")

  mkdirSync(dataDir, { recursive: true })
  if (!existsSync(localExt) && existsSync(globalExt)) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>((res) => {
      rl.question(`${fmt.info(`copy extensions to ${dataDir}?`)} [Y/n] `, res)
    })
    rl.close()
    if (!answer || answer.match(/^y(es)?$/i)) {
      console.error(fmt.detail("copying extensions from global install..."))
      cpSync(globalExt, localExt, { recursive: true })
    }
  }

  console.error(fmt.detail(`profile: ${dataDir}`))
}

export function buildCommand(
  mode: string,
  workDirs: string[],
  home: string,
  profileSandbox: boolean | string,
  appArgs: string[],
  apps: Record<string, AppDefinition>,
): Command {
  if (isBuiltinMode(mode)) {
    return buildBuiltinCommand(mode, appArgs)
  }
  return buildAppCommand(mode, workDirs, home, profileSandbox, appArgs, apps)
}

function buildBuiltinCommand(mode: BuiltinMode, appArgs: string[]): Command {
  switch (mode) {
    case "term": {
      const shell = process.env.SHELL ?? "/bin/zsh"
      if (!existsSync(shell)) {
        console.error(fmt.warn(`shell not found: ${shell}, falling back to /bin/zsh`))
        return { bin: "/bin/zsh", args: ["-l"] }
      }
      return { bin: shell, args: ["-l"] }
    }
    case "claude":
      return { bin: "claude", args: [] }
    case "exec":
      return { bin: appArgs[0], args: appArgs.slice(1) }
  }
}

function buildAppCommand(
  mode: string,
  workDirs: string[],
  home: string,
  profileSandbox: boolean | string,
  appArgs: string[],
  apps: Record<string, AppDefinition>,
): Command {
  const app = apps[mode]
  if (!app) {
    console.error(`\n${fmt.error(`unknown mode "${mode}"`)}\n`)
    process.exit(1)
  }

  const resolvedPath = resolveAppPath(app)
  if (!resolvedPath) {
    console.error(`\n${fmt.error(`could not find application for "${mode}"`)}`)
    if (app.bundle) console.error(fmt.detail(`bundle: ${app.bundle}`))
    console.error(fmt.detail("hint: set an explicit path in ~/.bxconfig.toml\n"))
    process.exit(1)
  }

  const bin = executableFromBundle(resolvedPath, app)
  const args: string[] = []

  if (profileSandbox) {
    const dataDir = resolveProfileDir(home, profileSandbox)
    args.push("--user-data-dir", join(dataDir, "data"))
    args.push("--extensions-dir", join(dataDir, "extensions"))
  }

  if (app.args) args.push(...app.args)
  if (appArgs.length > 0) args.push(...appArgs)
  args.push(...getPassPaths(app, workDirs, home))

  return { bin, args }
}

export function getActivationCommand(mode: string, apps: Record<string, AppDefinition>): Command | null {
  if (isBuiltinMode(mode)) return null

  const app = apps[mode]
  if (!app) return null

  if (app.bundle) {
    return { bin: "/usr/bin/open", args: ["-b", app.bundle] }
  }

  const resolved = resolveAppPath(app)
  if (!resolved) return null

  const bundlePath = appBundleFromPath(resolved)
  if (!bundlePath) return null

  return { bin: "/usr/bin/open", args: ["-a", bundlePath] }
}

export function getNestedSandboxWarning(mode: string, apps: Record<string, AppDefinition>): string | null {
  if (isBuiltinMode(mode)) return null

  const app = apps[mode]
  if (!app) return null

  const resolvedPath = resolveAppPath(app)
  if (!resolvedPath) return null

  const target = appBundleFromPath(resolvedPath) ?? resolvedPath

  try {
    const entitlements = execFileSync("codesign", ["-d", "--entitlements", "-", target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    if (hasAppSandboxEntitlement(entitlements)) {
      return `⚠️  "${mode}" has Apple App Sandbox enabled — nested sandboxing may cause issues`
    }
  } catch {
    // Ignore: unsigned apps, stripped metadata, missing tools
  }

  return null
}

export function bringAppToFront(mode: string, apps: Record<string, AppDefinition>) {
  const cmd = getActivationCommand(mode, apps)
  if (!cmd) return

  setTimeout(() => {
    try {
      const p = spawn(cmd.bin, cmd.args, { stdio: "ignore", detached: true })
      p.unref()
    } catch {
      // Ignore activation failures
    }
  }, 250)
}
