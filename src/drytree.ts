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

function insertPath(root: TreeNode, absPath: string, kind: EntryKind, isDir: boolean) {
  const parts = absPath.split("/").filter(Boolean)
  let node = root
  for (const part of parts) {
    if (!node.children.has(part)) {
      node.children.set(part, { children: new Map() })
    }
    node = node.children.get(part)!
  }
  node.kind = kind
  node.isDir = isDir
}

/** Collapse the tree down to the interesting nodes, keeping only branches
 *  that contain a leaf with a kind (blocked/ignored/workdir/read-only).
 *  Intermediate directories on the home path are kept as navigation context. */
function pruneTree(node: TreeNode, currentParts: string[], homeParts: string[], depth: number): boolean {
  if (node.kind) return true

  for (const [name, child] of [...node.children]) {
    const keep = pruneTree(child, [...currentParts, name], homeParts, depth + 1)
    if (!keep) node.children.delete(name)
  }

  return node.children.size > 0
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
  systemDenyPaths?: string[]
}

export function printDryRunTree({ home, blockedDirs, ignoredPaths, readOnlyDirs, workDirs, systemDenyPaths = [] }: DryRunData) {
  const root: TreeNode = { children: new Map() }
  const homeParts = home.split("/").filter(Boolean)

  for (const dir of blockedDirs) {
    insertPath(root, dir, "blocked", isDirectory(dir))
  }
  for (const path of ignoredPaths) {
    insertPath(root, path, "ignored", isDirectory(path))
  }
  for (const dir of readOnlyDirs) {
    insertPath(root, dir, "read-only", true)
  }
  for (const dir of workDirs) {
    insertPath(root, dir, "workdir", true)
  }
  for (const dir of systemDenyPaths) {
    insertPath(root, dir, "blocked", true)
  }

  pruneTree(root, [], homeParts, 0)

  console.log(`\n${CYAN}/${RESET}`)
  printNode(root, "")
  console.log(`\n${RED}✖${RESET} = denied  ${YELLOW}◉${RESET} = read-only  ${GREEN}✔${RESET} = read-write\n`)
}
