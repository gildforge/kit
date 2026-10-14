import { createHash } from 'node:crypto'
import { createInflate } from 'node:zlib'
import type { R2Bucket } from '@cloudflare/workers-types'
import { ApiError } from '../engine/api/errors.js'
import { FILE_BYTES, PUSH_BYTES } from '../engine/git-limits.js'

export interface GitObjectSize { hash: string; size: number }
type ObjectRef = { key: string; type: string; size: number; hash: string }
declare const FixedLengthStream: { new(size: number): TransformStream<Uint8Array,Uint8Array> }
const invalid = (message: string): never => { throw new ApiError(400, message) }
const tooLarge = (message: string): never => { throw new ApiError(413, message) }
class Bytes {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private pending: Uint8Array = new Uint8Array(0)
  offset = 0
  constructor(stream: ReadableStream<Uint8Array>, private hash?: ReturnType<typeof createHash>) { this.reader = stream.getReader() }
  async chunk() {
    if (this.pending.length) { const p = this.pending; this.pending = new Uint8Array(0); return p }
    return (await this.reader.read()).value ?? new Uint8Array(0)
  }
  unread(data: Uint8Array) { this.pending = data }
  async take(n: number, checksum = true) {
    const parts: Uint8Array[] = []; let left = n
    while (left) {
      const chunk = await this.chunk()
      if (!chunk.length) invalid('Truncated Git pack')
      const count = Math.min(left, chunk.length), part = chunk.subarray(0, count)
      parts.push(part); this.unread(chunk.subarray(count)); left -= count
    }
    const bytes = Buffer.concat(parts)
    this.offset += n
    if (checksum) this.hash?.update(bytes)
    return bytes
  }
  async byte() { return (await this.take(1))[0] }
  consumed(bytes: Uint8Array) { this.offset += bytes.length; this.hash?.update(bytes) }
  async variable() {
    let value = 0, shift = 0, b: number
    do { if (shift > 35) invalid('Invalid delta size'); b = await this.byte(); value += (b & 127) * 2 ** shift; shift += 7 } while (b & 128)
    return value
  }
}

/** Stage to R2, inspect one compressed stream at a time, and replay only a
 * validated pack. Neither the 2 GiB push nor a 100 MiB object is buffered in
 * Worker memory. Temporary object bytes also allow delta copies by R2 range. */
export async function preparePush(bucket: R2Bucket, body: ReadableStream<Uint8Array>,
  base: (hash: string) => Promise<{ type: string; bytes: Uint8Array }>) {
  const prefix = 'push-staging/' + Date.now() + '/' + crypto.randomUUID() + '/', keys: string[] = []
  const cleanup = async () => { for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000)) }
  let transfer = 0
  // An unknown-length incoming stream is supported by R2 via multipart upload.
  const upload = await bucket.createMultipartUpload(prefix + 'pack'); keys.push(upload.key)
  const parts: { partNumber: number; etag: string }[] = []
  const reader = body.getReader()
  try {
    let chunks: Uint8Array[] = [], bytes = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      transfer += next.value.length
      if (transfer > PUSH_BYTES) tooLarge('Push exceeds the 2 GiB pack limit')
      chunks.push(next.value); bytes += next.value.length
      if (bytes >= 5 * 1024 * 1024) { parts.push(await upload.uploadPart(parts.length + 1, Buffer.concat(chunks))); chunks = []; bytes = 0 }
    }
    if (bytes || !parts.length) parts.push(await upload.uploadPart(parts.length + 1, Buffer.concat(chunks)))
    await upload.complete(parts)
    const packed = await bucket.get(upload.key)
    if (!packed) return invalid('Staged push unavailable')
    const input = new Bytes(packed.body as unknown as ReadableStream<Uint8Array>)
    // Commands have already been authorized by streamPush; find their flush.
    for (;;) { const length = parseInt((await input.take(4)).toString(), 16); if (!length) break; await input.take(length - 4) }
    if (input.offset === transfer) return { body: packed.body, objects: [] as GitObjectSize[], cleanup, key: upload.key }
    const checksum = createHash('sha1')
    const pack = new Bytes(new ReadableStream({ async pull(c) { const chunk = await input.chunk(); if (chunk.length) c.enqueue(chunk); else c.close() } }), checksum)
    const header = await pack.take(12)
    if (header.subarray(0, 4).toString() !== 'PACK' || ![2, 3].includes(header.readUInt32BE(4))) invalid('Invalid Git pack')
    const count = header.readUInt32BE(8)
    if (count > 10000) tooLarge('Push exceeds the 10,000 object limit')
    const byOffset = new Map<number, ObjectRef>(), byHash = new Map<string, ObjectRef>()
    const objects = new Map<string, number>()
    const stage = async (size: number, produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>) => {
      const key = prefix + keys.length; keys.push(key)
      const stream = new FixedLengthStream(size), writer = stream.writable.getWriter()
      const put = bucket.put(key, stream.readable as never)
      // A rejected upload must not leave the producer blocked on backpressure.
      void put.catch(error => writer.abort(error))
      try { await produce(async bytes => { await writer.write(bytes as never) }); await writer.close(); await put }
      catch (error) { await writer.abort(error).catch(() => {}); await put.catch(() => {}); throw error }
      return key
    }
    const copy = async (ref: ObjectRef, offset: number, length: number, write: (bytes: Uint8Array) => Promise<void>) => {
      if (offset + length > ref.size) invalid('Delta copy exceeds base')
      const object = await bucket.get(ref.key, { range: { offset, length } })
      if (!object) return invalid('Delta base unavailable')
      const reader = object.body.getReader()
      for (;;) { const next = await reader.read(); if (next.done) break; await write(next.value) }
    }
    for (let i = 0; i < count; i++) {
      const offset = pack.offset
      let b = await pack.byte(), size = b & 15, shift = 4
      const type = (b >> 4) & 7
      while (b & 128) { if (shift > 35) invalid('Invalid pack size'); b = await pack.byte(); size += (b & 127) * 2 ** shift; shift += 7 }
      if (size > FILE_BYTES) tooLarge('File or Git object exceeds the 100 MiB limit')
      let parent: ObjectRef | undefined, baseHash: string | undefined
      if (type === 6) {
        b = await pack.byte(); let distance = b & 127
        while (b & 128) { b = await pack.byte(); distance = (distance + 1) * 128 + (b & 127); if (distance > offset) invalid('Invalid delta offset') }
        parent = byOffset.get(offset - distance)
      } else if (type === 7) {
        baseHash = (await pack.take(20)).toString('hex')
        parent = byHash.get(baseHash)
      } else if (![1, 2, 3, 4].includes(type)) invalid('Invalid pack object type')
      if (type === 6 && !parent) invalid('Missing delta base')
      const name = parent?.type ?? ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, string>)[type]
      const hash = createHash('sha1').update(`${name} ${size}\0`)
      const key = await stage(size, async write => {
        const inflater = createInflate(); let output = 0
        const consume = (async () => { for await (const data of inflater) { output += data.length; if (output > size) invalid('Invalid pack object length'); if (type < 6) hash.update(data); await write(data) } })()
        void consume.catch(error => inflater.destroy(error))
        try {
          for (;;) {
            const chunk = await pack.chunk()
            if (!chunk.length) invalid('Truncated compressed object')
            const before = inflater.bytesWritten
            await new Promise<void>((resolve, reject) => inflater.write(chunk, error => error ? reject(error) : resolve()))
            const used = inflater.bytesWritten - before
            pack.consumed(chunk.subarray(0, used)); pack.unread(chunk.subarray(used))
            if (used < chunk.length || inflater.readableEnded) break
          }
          await consume
          if (output !== size) invalid('Invalid pack object length')
        } catch (error) { inflater.destroy(); await consume.catch(() => {}); throw error }
      })
      let result: ObjectRef
      if (type === 6 || type === 7) {
        const delta = await bucket.get(key)
        if (!delta) return invalid('Delta unavailable')
        const instructions = new Bytes(delta.body as unknown as ReadableStream<Uint8Array>)
        const baseSize = await instructions.variable(), resultSize = await instructions.variable()
        if (resultSize > FILE_BYTES) tooLarge('Delta result exceeds the 100 MiB file limit')
        if (!parent && baseHash) {
          const existing = await base(baseHash)
          if (existing.bytes.length > FILE_BYTES) tooLarge('Delta base exceeds the 100 MiB limit')
          const actual = createHash('sha1').update(`${existing.type} ${existing.bytes.length}\0`).update(existing.bytes).digest('hex')
          if (actual !== baseHash) invalid('Invalid delta base hash')
          const baseKey = await stage(existing.bytes.length, write => write(existing.bytes))
          parent = { key: baseKey, type: existing.type, hash: baseHash, size: existing.bytes.length }; byHash.set(baseHash, parent)
        }
        if (!parent || baseSize !== parent.size) return invalid('Invalid delta base size')
        const resultType = parent.type
        const resultHash = createHash('sha1').update(`${resultType} ${resultSize}\0`)
        const resultKey = await stage(resultSize, async write => {
          let written = 0
          const append = async (bytes: Uint8Array) => { written += bytes.length; if (written > resultSize) invalid('Invalid delta result length'); resultHash.update(bytes); await write(bytes) }
          while (instructions.offset < size) {
            const opcode = await instructions.byte()
            if (opcode & 128) {
              let offset = 0, length = 0
              for (let j = 0; j < 4; j++) if (opcode & (1 << j)) offset += (await instructions.byte()) * 2 ** (8 * j)
              for (let j = 0; j < 3; j++) if (opcode & (1 << (j + 4))) length += (await instructions.byte()) * 2 ** (8 * j)
              await copy(parent!, offset, length || 65536, append)
            } else { if (!opcode) invalid('Invalid delta instruction'); await append(await instructions.take(opcode)) }
          }
          if (written !== resultSize) invalid('Invalid delta result length')
        })
        result = { key: resultKey, hash: resultHash.digest('hex'), type: resultType, size: resultSize }
      } else result = { key, hash: hash.digest('hex'), type: name, size }
      byOffset.set(offset, result); byHash.set(result.hash, result); objects.set(result.hash, result.size)
    }
    const expected = await pack.take(20, false)
    if (!expected.equals(checksum.digest()) || (await pack.chunk()).length) invalid('Invalid pack checksum')
    return { key: upload.key, objects: [...objects].map(([hash, size]) => ({ hash, size })), cleanup }
  } catch (error) { await reader.cancel().catch(() => {}); await upload.abort().catch(() => {}); await cleanup(); throw error }
}
