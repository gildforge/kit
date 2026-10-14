import { decodeResponse, type DeliveryResult } from '../../engine/events/http.js'
import type { connect as socketConnect } from 'cloudflare:sockets'
import { publicDestination, type Resolver } from '../../engine/events/security.js'
export const resolvePublic: Resolver = async (hostname, signal) => {
  const answers = await Promise.all(
    ['A', 'AAAA'].map(async (type) => {
      const url = new URL('https://cloudflare-dns.com/dns-query')
      url.searchParams.set('name', hostname)
      url.searchParams.set('type', type)
      const r = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        redirect: 'manual',
        signal,
      })
      if (!r.ok) throw Error('DNS lookup failed')
      const result = (await r.json()) as {
        Status: number
        Answer?: { type: number; data: string }[]
      }
      if (![0, 3].includes(result.Status)) throw Error('DNS lookup failed')
      return (result.Answer ?? [])
        .filter((a) => a.type === 1 || a.type === 28)
        .map((a) => a.data)
    }),
  )
  return answers.flat()
}
// Pin the checked public IP for the connection. TLS verifies the original
// hostname; DNS rebinding and redirects cannot switch the destination.
export async function deliverHTTP(
  urlString: string,
  headers: Record<string, string>,
  body: string,
  io: {connect: typeof socketConnect; resolve: Resolver; timeoutMs?: number},
): Promise<DeliveryResult> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(new Error('Webhook delivery timed out')), io.timeoutMs ?? 10000)
  let socket: ReturnType<typeof socketConnect> | undefined
  const abort = () => {
    void socket?.close().catch(() => {})
  }
  controller.signal.addEventListener('abort', abort)
  const run = async () => {
    const { url, address } = await publicDestination(
      urlString,
      io.resolve,
      controller.signal,
    )
    controller.signal.throwIfAborted()
    socket = io.connect(
      {
        hostname: address,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      },
      { secureTransport: url.protocol === 'https:' ? 'starttls' : 'off' },
    )
    void socket.closed.catch(() => {})
    await socket.opened
    if (url.protocol === 'https:')
      socket = socket.startTls({
        expectedServerHostname: url.hostname.replace(/^\[|\]$/g, ''),
      })
    void socket.closed.catch(() => {})
    controller.signal.throwIfAborted()
    const request = `POST ${url.pathname + url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nContent-Length: ${new TextEncoder().encode(body).length}\r\n${Object.entries(
      headers,
    )
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('')}\r\n${body}`
    const writer = socket.writable.getWriter()
    await writer.write(new TextEncoder().encode(request))
    writer.releaseLock()
    const reader = socket.readable.getReader(),
      parts: Uint8Array[] = []
    let size = 0,
      truncated = false
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const available = Math.max(0, 32768 - size)
      parts.push(next.value.subarray(0, available))
      size += next.value.length
      if (size > 32768) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    const bytes = new Uint8Array(Math.min(size, 32768))
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    return decodeResponse(bytes, truncated)
  }
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {once: true}))])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', abort)
    void socket?.close().catch(() => {})
  }
}
