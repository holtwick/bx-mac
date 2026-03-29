import { readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { fmt } from "./fmt.js"

export interface AppDefinition {
  /** Inherit from another app definition (resolved during merge) */
  mode?: string
  /** macOS bundle identifier for mdfind discovery */
  bundle?: string
  /** Relative path to executable inside .app bundle */
  binary?: string
  /** Absolute path to executable (user override, highest priority) */
  path?: string
  /** Absolute path fallback if discovery fails */
  fallback?: string
  /** Extra args always passed to the app */
  args?: string[]
  /** Whether to pass workdirs as launch arguments (default: true) */
  passWorkdirs?: boolean
  /** Preconfigured working directories (used when none given on CLI) */
  workdirs?: string[]
}

/** Built-in app definitions — always available, can be overridden via config */
export const BUILTIN_APPS: Record<string, AppDefinition> = {
  code: {
    bundle: "com.microsoft.VSCode",
    binary: "Contents/MacOS/Electron",
    fallback: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    args: ["--no-sandbox"],
  },
  xcode: {
    bundle: "com.apple.dt.Xcode",
    binary: "Contents/MacOS/Xcode",
    fallback: "/Applications/Xcode.app/Contents/MacOS/Xcode",
    passWorkdirs: false,
  },
}

/** Shell-only built-in modes that are not app definitions */
export const BUILTIN_MODES = ["term", "claude", "exec"] as const
export type BuiltinMode = (typeof BUILTIN_MODES)[number]

export interface BxConfig {
  apps: Record<string, AppDefinition>
}

function parseAppDef(def: Record<string, unknown>): AppDefinition {
  return {
    mode: typeof def.mode === "string" ? def.mode : undefined,
    bundle: typeof def.bundle === "string" ? def.bundle : undefined,
    binary: typeof def.binary === "string" ? def.binary : undefined,
    path: typeof def.path === "string" ? def.path : undefined,
    fallback: typeof def.fallback === "string" ? def.fallback : undefined,
    args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : undefined,
    passWorkdirs: typeof def.passWorkdirs === "boolean" ? def.passWorkdirs : undefined,
    workdirs: Array.isArray(def.workdirs) ? def.workdirs.filter((a): a is string => typeof a === "string") : undefined,
  }
}

/**
 * Load and parse ~/.bxconfig.toml. Returns empty apps if file missing or invalid.
 */
export function loadConfig(home: string): BxConfig {
  const configPath = join(home, ".bxconfig.toml")
  if (!existsSync(configPath)) return { apps: {} }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const doc = parseToml(raw) as Record<string, unknown>
    const apps: Record<string, AppDefinition> = {}

    // Collect app sections: top-level [name] and nested [apps.name] both work.
    // [apps.name] takes precedence over [name] if both exist.
    const sections: Record<string, Record<string, unknown>> = {}

    const APP_FIELDS = new Set(["mode", "bundle", "binary", "path", "fallback", "args", "passWorkdirs", "workdirs"])
    for (const [key, val] of Object.entries(doc)) {
      if (key === "apps") continue
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>
        if (Object.keys(obj).some((k) => APP_FIELDS.has(k))) {
          sections[key] = obj
        }
      }
    }
    if (doc.apps && typeof doc.apps === "object") {
      Object.assign(sections, doc.apps as Record<string, Record<string, unknown>>)
    }

    for (const [name, def] of Object.entries(sections)) {
      apps[name] = parseAppDef(def)
    }

    return { apps }
  } catch (err) {
    console.error(`\n${fmt.warn(`failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)}`)
    return { apps: {} }
  }
}

/**
 * Merge built-in apps with user config (config wins on conflict).
 * Resolves `mode` references: an app with `mode = "code"` inherits
 * all fields from the "code" definition, then overlays its own fields.
 */
export function getAvailableApps(config: BxConfig): Record<string, AppDefinition> {
  const merged: Record<string, AppDefinition> = {}

  for (const [name, def] of Object.entries(BUILTIN_APPS)) {
    merged[name] = { ...def }
  }

  for (const [name, def] of Object.entries(config.apps)) {
    if (merged[name]) {
      merged[name] = { ...merged[name], ...stripUndefined(def) }
    } else {
      merged[name] = def
    }
  }

  // Resolve mode references (supports chaining, detects cycles)
  for (const name of Object.keys(merged)) {
    merged[name] = resolveModeChain(name, merged)
  }

  return merged
}

function resolveModeChain(
  name: string,
  apps: Record<string, AppDefinition>,
  seen = new Set<string>(),
): AppDefinition {
  const def = apps[name]
  if (!def.mode) return def

  if (seen.has(name)) {
    console.error(`\n${fmt.warn(`circular mode reference: ${[...seen, name].join(" → ")}`)}`)
    const { mode: _, ...rest } = def
    return rest
  }
  seen.add(name)

  const target = apps[def.mode]
  if (!target) {
    console.error(`\n${fmt.warn(`mode "${def.mode}" not found for app "${name}"`)}`)
    const { mode: _, ...rest } = def
    return rest
  }

  const resolved = resolveModeChain(def.mode, apps, seen)
  const { mode: _, ...ownFields } = def
  return { ...resolved, ...stripUndefined(ownFields) }
}

function stripUndefined(obj: AppDefinition): Partial<AppDefinition> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v
  }
  return result as Partial<AppDefinition>
}

/**
 * Get all valid mode names (builtin modes + app names).
 */
export function getValidModes(apps: Record<string, AppDefinition>): string[] {
  return [...BUILTIN_MODES, ...Object.keys(apps)]
}

/**
 * Resolve an AppDefinition to an executable path.
 * Resolution chain: path (explicit) → mdfind + binary → fallback
 */
export function resolveAppPath(app: AppDefinition): string | null {
  // 1. Explicit path override
  if (app.path) {
    if (existsSync(app.path)) return app.path
    console.error(`\n${fmt.warn(`configured path not found: ${app.path}`)}`)
  }

  // 2. Auto-discovery via mdfind
  if (app.bundle) {
    try {
      const safeBundleId = app.bundle.replace(/'/g, "'\\''")
      const result = execFileSync("mdfind", [
        `kMDItemCFBundleIdentifier == '${safeBundleId}'`,
      ], { encoding: "utf-8", timeout: 5000 }).trim()

      const appPath = result.split("\n")[0]
      if (appPath) {
        if (app.binary) {
          const fullPath = join(appPath, app.binary)
          if (existsSync(fullPath)) return fullPath
        } else {
          // No binary specified — return the .app path (caller uses `open -a`)
          return appPath
        }
      }
    } catch {
      // mdfind failed or timed out — continue to fallback
    }
  }

  // 3. Hardcoded fallback
  if (app.fallback && existsSync(app.fallback)) return app.fallback

  return null
}
