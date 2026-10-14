import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { ApiError } from './api/errors.js'
export const PUSH_BYTES = 2 * 1024 * 1024 * 1024
export const FILE_BYTES = 100 * 1024 * 1024
export const REPO_BYTES = 5 * 1024 * 1024 * 1024
export const PUSHES_PER_HOUR = 300
export const PUSH_REFS = 100
export const REPO_REFS = 500
export function checkRefBudget(existing: string[], updates: { ref: string; sha: string }[]) {
  if (updates.length > PUSH_REFS) throw new ApiError(413, 'Push exceeds the 100 ref-update limit')
  const refs = new Set(existing)
  for (const update of updates) {
    if (/^0+$/.test(update.sha)) refs.delete(update.ref)
    else refs.add(update.ref)
  }
  if (refs.size > REPO_REFS) throw new ApiError(413, 'Repository exceeds the 500 branch/tag limit')
}

/** Bound both transfer bytes and decompressed smart-HTTP bytes. Content-Length
 * is only an early rejection: chunked bodies and gzip bombs take the same gate. */
export async function limitedBody(request: Request) {
  if (Number(request.headers.get('content-length')) > PUSH_BYTES)
    throw new ApiError(413, 'Push exceeds the 2 GiB pack limit')
  const read = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return new Uint8Array()
    const reader = stream.getReader(), parts: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.length
        if (bytes > PUSH_BYTES) throw new ApiError(413, 'Push exceeds the 2 GiB pack limit')
        parts.push(next.value)
      }
    } catch (error) { await reader.cancel(); throw error }
    const body = new Uint8Array(bytes)
    let at = 0
    for (const part of parts) { body.set(part, at); at += part.length }
    return body
  }
  const body = await read(request.body)
  const scan = request.headers.get('content-encoding')?.includes('gzip')
    ? await read(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')))
    : body
  return { body, scan }
}

/** Inspect the pack before forwarding. Delta result sizes, not just compressed
 * delta instructions, count against the file and repository budgets. Charging
 * every incoming object conservatively includes retained history and duplicates;
 * an ambiguous upstream outcome must never free a reservation. */
export function packBudget(bytes: Uint8Array) {
  let at = 0
  const reject = (message: string): never => { throw new ApiError(413, message) }
  while (at + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, at + 4)), 16)
    if (length === 0) { at += 4; break }
    if (!Number.isFinite(length) || length < 4 || at + length > bytes.length)
      throw new ApiError(400, 'Invalid receive-pack commands')
    at += length
  }
  if (at === bytes.length) return 0 // ref deletion, no pack
  const pack = Buffer.from(bytes.subarray(at))
  if (pack.subarray(0, 4).toString() !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4)))
    throw new ApiError(400, 'Invalid Git pack')
  const count = pack.readUInt32BE(8)
  if (count > 10000) reject('Push exceeds the 10,000 object limit')
  at = 12
  let total = 0
  const variable = (data: Uint8Array, cursor: { at: number }) => {
    let value = 0, shift = 0, b: number
    do {
      if (cursor.at >= data.length || shift > 35) throw new ApiError(400, 'Invalid delta size')
      b = data[cursor.at++]
      value += (b & 127) * 2 ** shift; shift += 7
    } while (b & 128)
    return value
  }
  for (let i = 0; i < count; i++) {
    let b = pack[at++], size = b & 15, shift = 4
    const type = (b >> 4) & 7
    while (b & 128) {
      if (at >= pack.length || shift > 35) throw new ApiError(400, 'Invalid pack size')
      b = pack[at++]; size += (b & 127) * 2 ** shift; shift += 7
    }
    if (size > FILE_BYTES) reject('File or Git object exceeds the 100 MiB limit')
    if (type === 6) { do { b = pack[at++] } while (b & 128 && at < pack.length) }
    else if (type === 7) at += 20
    else if (![1, 2, 3, 4].includes(type)) throw new ApiError(400, 'Invalid pack object type')
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } }
    try {
      inflated = inflateSync(pack.subarray(at), { maxOutputLength: FILE_BYTES, info: true }) as unknown as typeof inflated
    } catch { return reject('Invalid pack or file exceeds the 100 MiB limit') }
    const object = inflated.buffer as unknown as Buffer
    if (object.length !== size) throw new ApiError(400, 'Invalid pack object length')
    at += inflated.engine!.bytesWritten
    let charged = size
    if (type === 6 || type === 7) {
      const cursor = { at: 0 }
      variable(object, cursor)
      charged = variable(object, cursor)
      if (charged > FILE_BYTES) reject('Delta result exceeds the 100 MiB file limit')
    }
    total += charged
    if (total > REPO_BYTES) reject('Push exceeds the 5 GiB repository budget')
  }
  if (at + 20 !== pack.length || !createHash('sha1').update(pack.subarray(0, at)).digest().equals(pack.subarray(at)))
    throw new ApiError(400, 'Invalid pack checksum')
  return total
}
