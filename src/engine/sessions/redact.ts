import type { Receipt } from '../sessions-contract.js'
const REDACTED = '[redacted]'
function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.values()].reduce((sum, n) => sum - n / value.length * Math.log2(n / value.length), 0)
}
export function redact(value: string, cap = 4096) {
  // Recognizable bearer/API credentials are removed even when they have low
  // entropy. Generic opaque strings cover unprefixed Cloudflare/AWS secrets.
  const safe = value
    .replace(/\b(?:gf|gr|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(\b(?:[\w-]*(?:token|secret|password|api[_-]?key|credential)[\w-]*\s*[=:]\s*|Bearer\s+)["']?)[^\s"']+/gi, '$1' + REDACTED)
    .replace(/[A-Za-z0-9_+\/-]{24,}={0,2}/g, v => entropy(v) >= 3.3 ? REDACTED : v)
  return safe.length > cap ? safe.slice(0, cap - 12) + ' [truncated]' : safe
}
export function redactReceipt<T extends Receipt>(receipt: T): T {
  return {
    ...receipt,
    model: redact(receipt.model, 120),
    commands: receipt.commands.map(c => ({...c, name: redact(c.name, 1024)})),
    files: {read: receipt.files.read.map(p => redact(p, 1024)), written: receipt.files.written.map(p => redact(p, 1024))},
    notes: redact(receipt.notes),
  }
}
