import { statSync } from "node:fs"

// ANSI color codes
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

type EntryKind = "blocked" | "ignored" | "read-only" | "workdir"

interface TreeNode {
  kind?: EntryKind
  isDir?: boolean
  children: Map<string, TreeNode>
}

function kindIcon(kind: EntryKind): string {
  switch (kind) {
    case "read-only": return `${YELLOW}◉${RESET}`
    case "workdir":   return `${GREEN}✔${RESET}`
    default:          return `${RED}✖${RESET}`
  }
}

function insertPath(root: TreeNode, home: string, absPath: string, kind: EntryKind, isDir: boolean) {
  const rel = absPath.startsWith(home + "/") ? absPath.slice(home.length + 1) : absPath
  let node = root
  for (const part of rel.split("/")) {
    if (!node.children.has(part)) {
      node.children.set(part, { children: new Map() })
    }
    node = node.children.get(part)!
  }
  node.kind = kind
  node.isDir = isDir
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Dotfiles without stat access are assumed to be directories
    return path.slice(path.lastIndexOf("/") + 1).startsWith(".")
  }
}

function printNode(node: TreeNode, prefix: string) {
  const entries = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  for (let i = 0; i < entries.length; i++) {
    const [name, child] = entries[i]
    const isLast = i === entries.length - 1
    const connector = isLast ? "└── " : "├── "
    const continuation = isLast ? "    " : "│   "

    if (child.kind) {
      const suffix = child.isDir ? "/" : ""
      console.log(`${prefix}${connector}${kindIcon(child.kind)} ${name}${suffix}  ${DIM}${child.kind}${RESET}`)
    } else {
      console.log(`${prefix}${connector}${CYAN}${name}/${RESET}`)
    }

    if (child.children.size > 0) {
      printNode(child, prefix + continuation)
    }
  }
}

export interface DryRunData {
  home: string
  blockedDirs: string[]
  ignoredPaths: string[]
  readOnlyDirs: Set<string>
  workDirs: string[]
}

export function printDryRunTree({ home, blockedDirs, ignoredPaths, readOnlyDirs, workDirs }: DryRunData) {
  const root: TreeNode = { children: new Map() }

  for (const dir of blockedDirs) {
    insertPath(root, home, dir, "blocked", true)
  }
  for (const path of ignoredPaths) {
    insertPath(root, home, path, "ignored", isDirectory(path))
  }
  for (const dir of readOnlyDirs) {
    insertPath(root, home, dir, "read-only", true)
  }
  for (const dir of workDirs) {
    insertPath(root, home, dir, "workdir", true)
  }

  console.log(`\n${CYAN}~/${RESET}`)
  printNode(root, "")
  console.log(`\n${RED}✖${RESET} = denied  ${YELLOW}◉${RESET} = read-only  ${GREEN}✔${RESET} = read-write\n`)
}
