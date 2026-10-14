// The slice of the Cloudflare API an install uses, over an injected fetch so
// the same calls run in gild desktop (Tauri's HTTP client), Node and tests.
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class CloudflareError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) {
    super(message)
  }
}

interface Envelope<T> {
  success: boolean
  result: T
  errors?: { code: number; message: string }[]
  result_info?: { page?: number; total_pages?: number; cursor?: string }
}

export const API = 'https://api.cloudflare.com/client/v4'

export class Cloudflare {
  constructor(readonly token: string, readonly fetch: Fetch) {}

  async call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Envelope<T>> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.token}`)
    let body = init.body
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(init.json)
    }
    const res = await this.fetch(`${API}${path}`, { ...init, headers, body })
    const text = await res.text()
    let data: Envelope<T>
    try {
      data = JSON.parse(text) as Envelope<T>
    } catch {
      throw new CloudflareError(res.status, [], `${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    if (!res.ok || !data.success) {
      const errors = data.errors ?? []
      throw new CloudflareError(res.status, errors.map(e => e.code), `${init.method ?? 'GET'} ${path}: ${errors.map(e => e.message).join('; ') || `HTTP ${res.status}`}`)
    }
    return data
  }

  async get<T>(path: string) {
    return (await this.call<T>(path)).result
  }

  /** Every page of a paged list. */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; ; page++) {
      const data = await this.call<T[]>(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`)
      out.push(...(data.result ?? []))
      const pages = data.result_info?.total_pages
      if (!pages || page >= pages || !data.result?.length) return out
    }
  }
}
