import type { MemFS } from '../../engine/memfs.js'
import { DIR, readJson, writeJson } from '../metastore.js'
import { metadataEvents, type MetadataSnapshot } from './payloads.js'
export async function metadataSnapshot(fs: MemFS): Promise<MetadataSnapshot> {
  const out: MetadataSnapshot = {}
  for (const name of (await fs.readdir(`${DIR}/.gild`).catch(() => [])).filter(
    (n) => /^\d+$/.test(n),
  ))
    for (const sub of ['issue', 'pr', 'log'])
      for (const file of await fs
        .readdir(`${DIR}/.gild/${name}/${sub}`)
        .catch(() => [])) {
        const path = `.gild/${name}/${sub}/${file}`,
          value = await readJson(fs, `${DIR}/${path}`)
        if (value) out[path] = value
      }
  out['.gild/queue.json'] =
    (await readJson(fs, `${DIR}/.gild/queue.json`)) ?? []
  return out
}
export async function recordMetadataEvents(
  fs: MemFS,
  before: MetadataSnapshot,
  repository: string,
  by: string,
  refs: Record<string, string>,
) {
  const after = await metadataSnapshot(fs),
    events = metadataEvents(before, after, repository, by, refs)
  if (events.length) await fs.mkdir(`${DIR}/.gild/events`).catch(() => {})
  for (const event of events)
    await writeJson(fs, `${DIR}/.gild/events/${event.id}.json`, event)
}
