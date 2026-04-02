import { readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/** Expand glob patterns (e.g. ~/work/*) in path lists. Only directories are matched. */
export function expandGlobs(paths: string[], home: string): string[] {
  const result: string[] = []
  for (const p of paths) {
    const resolved = p.replace(/^~(\/|$)/, home + "/")
    if (!resolved.includes("*")) {
      result.push(resolved)
      continue
    }
    const dir = dirname(resolved)
    const pattern = basename(resolved)
    const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && regex.test(entry.name)) {
          result.push(join(dir, entry.name))
        }
      }
    } catch {
      // directory does not exist - skip silently
    }
  }
  return result
}
