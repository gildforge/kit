import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { MemFS } from './memfs.js'
/** Copy every advertised branch/tag, including forge-owned _meta, and verify
 * the destination before publishing a logical rename. No token is persisted. */
export async function mirrorGit(
  source: string,
  destination: string,
  read: string,
  write: string,
) {
  const fs = new MemFS(),
    dir = '/mirror',
    onAuth = () => ({ username: 'x', password: read.split('?')[0] }),
    targetAuth = () => ({ username: 'x', password: write.split('?')[0] })
  const refs = (
    await git.listServerRefs({ http, url: source, onAuth, prefix: 'refs/' })
  ).filter((r) => !r.ref.endsWith('^{}'))
  if (!refs.length) return
  await git.clone({
    fs,
    dir,
    http,
    url: source,
    onAuth,
    noCheckout: true,
    singleBranch: false,
  })
  await git.addRemote({ fs, dir, remote: 'destination', url: destination })
  for (const ref of refs) {
    await git.fetch({
      fs,
      dir,
      http,
      remote: 'origin',
      ref: ref.ref,
      onAuth,
      singleBranch: true,
      tags: true,
    })
    await git.writeRef({ fs, dir, ref: ref.ref, value: ref.oid, force: true })
    await git.push({
      fs,
      dir,
      http,
      remote: 'destination',
      ref: ref.ref,
      remoteRef: ref.ref,
      onAuth: targetAuth,
    })
  }
  const copied = await git.listServerRefs({
    http,
    url: destination,
    onAuth: targetAuth,
    prefix: 'refs/',
  })
  if (refs.some((r) => !copied.some((c) => c.ref === r.ref && c.oid === r.oid)))
    throw new Error('Repository copy did not preserve every Git ref')
}
