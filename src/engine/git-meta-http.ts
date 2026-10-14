import http from 'isomorphic-git/http/web'
import { defaultAdvertisement } from './git-default.js'

/** Explicit metadata/object fetches must work while the Artifacts default
 * branch is unborn. isomorphic-git requires a resolvable remote HEAD even
 * when fetching another ref. Only the small v0 advertisement is rewritten. */
export const metaHttp: typeof http = {
  async request(options) {
    const response = await http.request(options)
    const url = new URL(options.url)
    if (response.statusCode !== 200 || !response.body || !url.pathname.endsWith('/info/refs') ||
        url.searchParams.get('service') !== 'git-upload-pack') return response
    const decoder = new TextDecoder()
    let body = ''
    for await (const chunk of response.body) body += decoder.decode(chunk, { stream: true })
    body += decoder.decode()
    return { ...response, body: (async function* () {
      yield new TextEncoder().encode(defaultAdvertisement(body, '_meta'))
    })() }
  },
}
