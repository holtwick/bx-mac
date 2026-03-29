import { cpSync, existsSync, mkdirSync } from "node:fs"
import { join, basename } from "node:path"
import { spawn, execFileSync } from "node:child_process"
import process from "node:process"
import type { AppDefinition } from "./config.js"
import { resolveAppPath, BUILTIN_MODES, type BuiltinMode } from "./config.js"

interface Command {
  bin: string
  args: string[]
}

function shouldPassWorkdirs(app: AppDefinition, mode: string): boolean {
  const explicit = (app as AppDefinition & { passWorkdirs?: unknown }).passWorkdirs
  if (typeof explicit === "boolean") return explicit
  // Backward-compatible default until every caller provides passWorkdirs in app definitions.
  return mode !== "xcode"
}

function appBundleFromExecutablePath(path: string): string | null {
  if (path.endsWith(".app")) return path

  const marker = ".app/"
  const idx = path.indexOf(marker)
  if (idx < 0) return null
  return path.slice(0, idx + ".app".length)
}

function executablePathFromAppBundle(path: string, app: AppDefinition): string {
  if (!path.endsWith(".app")) return path
  if (app.binary) return join(path, app.binary)

  const appName = basename(path, ".app")
  return join(path, "Contents", "MacOS", appName)
}

export function hasAppSandboxEntitlement(entitlements: string): boolean {
  const xmlTrue = /<key>\s*com\.apple\.security\.app-sandbox\s*<\/key>\s*<true\s*\/>/i
  if (xmlTrue.test(entitlements)) return true

  const xmlFalse = /<key>\s*com\.apple\.security\.app-sandbox\s*<\/key>\s*<false\s*\/>/i
  if (xmlFalse.test(entitlements)) return false

  const kvTrue = /com\.apple\.security\.app-sandbox\s*[=:]\s*(1|true)/i
  return kvTrue.test(entitlements)
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
  appArgs: string[],
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
        return { bin: appArgs[0], args: appArgs.slice(1) }
      }
    }
  }

  // App mode — resolve from app definitions
  const app = apps[mode]
  if (!app) {
    console.error(`sandbox: unknown mode "${mode}"`)
    process.exit(1)
  }

  const resolvedPath = resolveAppPath(app)
  if (!resolvedPath) {
    console.error(`sandbox: could not find application for "${mode}"`)
    if (app.bundle) console.error(`  bundle: ${app.bundle}`)
    console.error("  hint: set an explicit path in ~/.bxconfig.toml")
    process.exit(1)
  }

  const bin = executablePathFromAppBundle(resolvedPath, app)

  const args: string[] = []

  // VSCode-specific: profile sandbox flags
  if (mode === "code" && profileSandbox) {
    const dataDir = join(home, ".vscode-sandbox")
    args.push("--user-data-dir", join(dataDir, "data"))
    args.push("--extensions-dir", join(dataDir, "extensions"))
  }

  // App-specific extra args
  if (app.args) args.push(...app.args)

  // Optional CLI app args after "--" (e.g. bx xcode <workdir> -- MyApp.xcworkspace)
  if (appArgs.length > 0) args.push(...appArgs)

  // Workdirs: per-app behavior, defaults to true (xcode remains false by default).
  if (shouldPassWorkdirs(app, mode)) {
    args.push(...workDirs)
  }

  return { bin, args }
}

/**
 * Best-effort app activation for GUI app modes.
 * Runs outside the sandbox so macOS can bring the app to front.
 */
export function getActivationCommand(mode: string, apps: Record<string, AppDefinition>): Command | null {
  if ((BUILTIN_MODES as readonly string[]).includes(mode)) return null

  const app = apps[mode]
  if (!app) return null

  if (app.bundle) {
    return { bin: "/usr/bin/open", args: ["-b", app.bundle] }
  } else {
    const bin = resolveAppPath(app)
    if (!bin) return null
    const bundlePath = appBundleFromExecutablePath(bin)
    if (!bundlePath) return null
    return { bin: "/usr/bin/open", args: ["-a", bundlePath] }
  }
}

/**
 * Best-effort warning for apps that are already sandboxed by Apple entitlements.
 * Nested sandboxing can lead to unexpected EPERM/launch behavior.
 */
export function getNestedSandboxWarning(mode: string, apps: Record<string, AppDefinition>): string | null {
  if ((BUILTIN_MODES as readonly string[]).includes(mode)) return null

  const app = apps[mode]
  if (!app) return null

  const resolvedPath = resolveAppPath(app)
  if (!resolvedPath) return null

  const target = appBundleFromExecutablePath(resolvedPath) ?? resolvedPath

  try {
    const entitlements = execFileSync("codesign", ["-d", "--entitlements", "-", target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    if (hasAppSandboxEntitlement(entitlements)) {
      return `sandbox: warning: app "${mode}" appears to have Apple App Sandbox enabled; nested sandboxing may cause startup/access issues`
    }
  } catch {
    // Ignore inspection failures (unsigned apps, stripped metadata, missing tools).
  }

  return null
}

export function bringAppToFront(mode: string, apps: Record<string, AppDefinition>) {
  const cmd = getActivationCommand(mode, apps)
  if (!cmd) return

  // Slight delay helps when app is still bootstrapping.
  setTimeout(() => {
    try {
      const p = spawn(cmd.bin, cmd.args, { stdio: "ignore", detached: true })
      p.unref()
    } catch {
      // Ignore activation failures (launch itself already happened).
    }
  }, 250)
}
