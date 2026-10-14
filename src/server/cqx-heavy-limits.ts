import type { SourceFile } from './cqx-module.js'

// Polly: 801 files / 4,479,697 bytes / 50.69 MiB WASM at emit.
// Twice Polly: 1,602 / 8,959,394 / 88.25 MiB, before JS/RPC overhead.
// Bound the combined C + C# payload before RPC (128 MiB isolate budget).
// Existing source-loader ceiling, shared by clone and indexed/API snapshots.
export const CQX_MAX_SOURCE_FILE_BYTES = 512 * 1024
export type { CFamilyIssue } from '../engine/cqx-report.js'

export const HEAVY_MAX_FILES = 1_000
export const HEAVY_MAX_BYTES = 5 * 1024 * 1024

export function heavyWithinLimits(files: SourceFile[]): boolean {
  if (files.length > HEAVY_MAX_FILES) return false
  const encoder = new TextEncoder()
  let bytes = 0
  for (const file of files) {
    // UTF-8 is never smaller than its UTF-16 code-unit count. Avoid allocating
    // an encoded copy of a single oversized source just to reject it.
    if (file.text.length > HEAVY_MAX_BYTES - bytes) return false
    bytes += encoder.encode(file.text).byteLength
    if (bytes > HEAVY_MAX_BYTES) return false
  }
  return true
}
