import { awaitCurrentIndex } from './repo-index-ready.js'
import type { Refs } from './repo-refs.js'

interface PushIndex {
  refresh(owner: string, repo: string): Promise<unknown>
  status(): Promise<{ ready: boolean; refreshing: boolean }>
  refs(): Promise<{ refs: { kind: string; name: string; hash: string }[]; defaultBranch: string; meta: string | null }>
}

/** The Git acknowledgement is a publication boundary. Index and persist the
 * presentation on the writer, leaving readers only stored immutable bytes. */
export async function publishPushPresentation(
  index: PushIndex, owner: string, repo: string,
  readLive: () => Promise<Refs>,
  publish: () => Promise<void>,
) {
  await index.refresh(owner, repo)
  await awaitCurrentIndex(index, owner, repo, await readLive(), readLive, 30_000)
  await publish()
}

/** Follow renderer continuations in separate invocations, bounding each batch. */
export async function publishPushBatches(
  renderer: { fetch(url: string, init: RequestInit): Promise<Response> },
  initial: { entity: string; repository: string },
) {
  let body: object = initial
  for (;;) {
    const response = await renderer.fetch('https://gild-render/publish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error('Git accepted the push; presentation publication is pending. Retry shortly.')
    if (response.status === 204) return
    body = { ...initial, ...await response.json() as object }
  }
}
