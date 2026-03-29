export const DIM = "\x1b[2m"
export const RESET = "\x1b[0m"
export const CYAN = "\x1b[36m"
export const YELLOW = "\x1b[33m"

const PREFIX = `${CYAN}bx${RESET}`

export const fmt = {
  info: (msg: string) => `🔒 ${PREFIX} · ${msg}`,
  warn: (msg: string) => `⚠️  ${PREFIX} · ${msg}`,
  error: (msg: string) => `🚫 ${PREFIX} · ${msg}`,
  detail: (msg: string) => `   ${DIM}${msg}${RESET}`,
}
