import type { PageReads } from '../page-reads.js'
import { resolvePicture, type ProfilePicture } from '../../engine/profile.js'
import { contributorAcl, agentAttached } from '../repo-read.js'
declare const HTMLRewriter: typeof import('@cloudflare/workers-types').HTMLRewriter
/** The fragment page's viewer state (identity, stars, write access), from the
 *  same D1 batch that decided the page's privacy. It travels inside the page
 *  response, so the code view never fetches it after load. */
export interface FragmentIslands { repository: string; name: string | null; picture: ProfilePicture | null; count: number; starred: boolean; write: boolean; /** May see Actions, Agents and Score. */ contributor: boolean; /** Display a verified unclaimed key without treating it as a claimed viewer. */ claimed?: boolean }
export async function fragmentIslands(reads: PageReads): Promise<FragmentIslands> {
  const [owner] = reads.address.split('/'), viewer = reads.viewer, name = viewer?.name ?? null
  const profile = viewer?.profile ? (JSON.parse(viewer.profile) as { picture?: string | null }) : null
  return {
    repository: reads.canonical.state.key,
    name,
    picture: viewer ? await resolvePicture(profile?.picture, viewer.email) : null,
    count: reads.canonical.stars,
    starred: !!name && reads.canonical.starred,
    // mayWrite: the owner, or an owner/admin of the owning org; never an agent.
    write: !!name && !name.includes('/') && (name.toLowerCase() === owner || reads.role === 'owner' || reads.role === 'admin'),
    contributor: !!reads.access.value && !!name && (name.includes('/') ? agentAttached(reads.access.value.acl, name) : contributorAcl(owner, name, reads.role, reads.access.value.acl)),
  }
}
const encoder = new TextEncoder()
const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
/** Select the cached account shell from the page's existing viewer batch,
 *  then stream HTML and its inline viewer state in the same response. */
export function withIslands(response: Response, islands: Promise<FragmentIslands | null>): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/html')) return response
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  void (async () => {
    const writer = writable.getWriter()
    try {
      const data = await islands.catch(() => null)
      // The renderer stores both shared shells once. Select the account shell
      // from the already-authorized viewer batch without rendering on a read.
      const personalized = data?.name ? new HTMLRewriter()
        .on('template[data-portal-template]', { element(e) { e.removeAndKeepContent() } })
        .on('template[data-portal-template] script[data-island-props]', {
          element(e) {
            e.setInnerContent(JSON.stringify({ identity: { name: data.name, avatar: data.picture ?? undefined } }).replaceAll('<', '\\u003c'), { html: true })
          },
        })
        .on('.site-header', { element(e) { e.remove() } })
        .on('.sidebar-identity', { element(e) { e.setAttribute('data-tip', '@' + data.name) } })
        .on('.sidebar-identity [role="img"]', {
          element(e) {
            e.setAttribute('aria-label', 'Profile picture for ' + data.name)
            if (data.picture?.url) {
              e.setAttribute('data-picture-source', data.picture.source)
              e.setInnerContent(`<img src="${attribute(data.picture.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover">`, { html: true })
            }
          },
        })
        .on('[data-anonymous-star]', { element(e) { e.remove() } })
        .on('template[data-star-template]', { element(e) { e.removeAndKeepContent() } })
        .on('[data-star]', { element(e) { e.setAttribute('aria-pressed', String(data.starred)) } })
        .on('[data-star-label]', { element(e) { e.setInnerContent(data.starred ? '★ Unstar' : '☆ Star') } })
        .on('[data-star-count]', { element(e) { e.setInnerContent(String(data.count)); e.setAttribute('title', `${data.count} stars`) } })
        .on('[data-settings]', { element(e) { if (data.write) e.removeAttribute('hidden') } })
        .on('[data-contributor]', { element(e) { if (data.contributor || data.write) e.removeAttribute('hidden') } })
        .on('body > footer', { element(e) { e.remove() } })
        .on('body > main', { element(e) { e.setAttribute('class', 'portal-main'); e.removeAttribute('style') } })
        .transform(response as unknown as import('@cloudflare/workers-types').Response) : response
      const reader = personalized.body!.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; await writer.write(value) }
      if (data) {
        const viewer = data.claimed === false ? { ...data, name: null } : data
        await writer.write(encoder.encode(`<script type="application/json" id="gild-islands">${JSON.stringify(viewer).replaceAll('<', '\\u003c')}</script>`))
      }
      await writer.close()
    } catch (error) { await writer.abort(error) }
  })()
  const out = new Response(readable, { status: response.status, statusText: response.statusText, headers: response.headers })
  out.headers.delete('content-length')
  // Even a public repository's response includes per-viewer state. The
  // immutable shell/fragments underneath retain their shared cache entries.
  out.headers.set('cache-control', 'private, no-store')
  return out
}
