// A no-checkout shallow clone by immutable oid, shared by the production
// alarm and the local smart-HTTP/workerd fixture. It bounds memory to one
// snapshot pack instead of retaining an entire repository's history.
import * as git from 'isomorphic-git'
import { metaHttp as http } from './git-meta-http.js'
import { MemFS } from './memfs.js'
import { gitSource } from './repo-indexer.js'
export async function snapshotSource(url: string, hash: string, token?: string) {
  const fs = new MemFS(), dir = '/meta'
  await git.init({ fs: fs as never, dir })
  await git.addRemote({ fs: fs as never, dir, remote: 'origin', url })
  await git.fetch({ fs: fs as never, http, dir, url, ref: hash, depth: 1, singleBranch: true, tags: false, cache: fs.gitCache, ...(token ? { onAuth: () => ({ username: 'x', password: token }) } : {}) })
  return gitSource(fs, dir, fs.gitCache)
}
