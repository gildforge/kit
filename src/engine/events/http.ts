export interface DeliveryResult {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder()
/** Bounded diagnostic body with HTTP chunk framing removed. No redirect or
 * response content is executed; headers/body are displayed as escaped text. */
export function decodeResponse(
  bytes: Uint8Array,
  truncated = false,
): DeliveryResult {
  let at = 0,
    status = 0,
    headers: Record<string, string> = {}
  for (let interim = 0; interim < 5; interim++) {
    const remaining = bytes.subarray(at)
    let split = -1
    for (let i = 0; i + 3 < remaining.length; i++)
      if (
        remaining[i] === 13 &&
        remaining[i + 1] === 10 &&
        remaining[i + 2] === 13 &&
        remaining[i + 3] === 10
      ) {
        split = i
        break
      }
    const text = new TextDecoder('latin1').decode(remaining.subarray(0, split))
    if (split < 0 || split > 16384)
      throw Error('Invalid webhook response headers')
    const [line, ...lines] = text.slice(0, split).split('\r\n')
    status = Number(/^HTTP\/1\.[01] ([0-9]{3})/.exec(line)?.[1])
    if (status < 100 || status > 599 || !status)
      throw Error('Invalid webhook HTTP response')
    headers = Object.fromEntries(
      lines.flatMap((line) => {
        const colon = line.indexOf(':')
        return colon > 0
          ? [[line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]]
          : []
      }),
    )
    at += split + 4
    if (status >= 200) break
  }
  if (status < 200) throw Error('Missing final webhook response')
  let body = bytes.subarray(at)
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    const parts: Uint8Array[] = []
    let cursor = 0,
      length = 0,
      ended = false
    while (cursor < body.length) {
      const text = decoder.decode(body.subarray(cursor)),
        end = text.indexOf('\r\n')
      if (end < 0) {
        truncated = true
        break
      }
      const sizeText = text.slice(0, end).split(';')[0]
      if (!/^[a-f0-9]+$/i.test(sizeText))
        throw Error('Invalid webhook chunk size')
      const size = parseInt(sizeText, 16)
      cursor += encoder.encode(text.slice(0, end + 2)).length
      if (!size) {
        ended = true
        break
      }
      const part = body.subarray(cursor, Math.min(cursor + size, body.length))
      parts.push(part)
      length += part.length
      if (part.length !== size) {
        truncated = true
        break
      }
      cursor += size + 2
    }
    truncated ||= !ended
    body = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      body.set(part, offset)
      offset += part.length
    }
  }
  return {
    status,
    headers,
    body: decoder.decode(body.subarray(0, 8192)),
    truncated: truncated || body.length > 8192,
  }
}
