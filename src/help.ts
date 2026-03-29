import { loadConfig, getAvailableApps } from "./config.js"

export function printHelp(version: string) {
  const HOME = process.env.HOME
  const usageLines = buildUsageLines(HOME, version)
  console.log(usageLines)
  console.log(OPTIONS_TEXT)
}

function buildUsageLines(home: string | undefined, version: string): string {
  const header = `bx ${version} — launch apps in a macOS sandbox`
  const appSection = home ? buildAppUsageLines(home) : ""

  return `${header}

Usage:
  bx [workdir...]                            VSCode (default)
${appSection}  bx term [workdir...]                       sandboxed login shell
  bx claude [workdir...]                     Claude Code CLI
  bx exec [workdir...] -- command [args...]  arbitrary command`
}

function buildAppUsageLines(home: string): string {
  const config = loadConfig(home)
  const apps = getAvailableApps(config)
  const names = Object.keys(apps)
  const maxLen = Math.max(...names.map((n) => n.length))
  const colWidth = 41 // "  bx <name> [workdir...] [-- app-args...]" base width

  return names
    .map((name) => {
      const left = `  bx ${name} [workdir...] [-- app-args...]`
      const padding = " ".repeat(Math.max(1, colWidth + maxLen - name.length - left.length + 2))
      return `${left}${padding}${name} (app)`
    })
    .join("\n") + "\n"
}

const OPTIONS_TEXT = `
Options:
  --dry                show what will be protected, don't launch
  --verbose            print the generated sandbox profile
  --profile-sandbox    use an isolated VSCode profile (code mode only)
  -v, --version        show version
  -h, --help           show this help

Configuration:
  ~/.bxconfig.toml     app definitions (TOML):
                         [apps.name]           add a new app
                         bundle = "..."         macOS bundle ID (auto-discovery)
                         binary = "..."         relative path in .app bundle
                         path = "..."           explicit executable path
                         args = ["..."]         extra arguments
                         passWorkdirs = true|false pass workdirs as launch args
                       built-in apps (code, xcode) can be overridden
  ~/.bxignore          sandbox rules (one per line):
                         path         block access (deny)
                         rw:path      allow read-write access
                         ro:path      allow read-only access
  <workdir>/.bxignore  blocked paths in project (.gitignore-style matching)
                         / or .         self-protect: block entire directory
  <dir>/.bxprotect     marker file: block the containing directory

https://github.com/holtwick/bx-mac`
