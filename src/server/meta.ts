// Initializes a fresh repo: normally an EMPTY root commit on `main`, then
// the orphan `_meta` root commit (the ACL naming the owner — user or org —
// and the shared issue/PR counter). Runs in the Worker via isomorphic-git
// on an in-memory fs; pushes use a minted repo-scoped token, never user
// creds.
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { MemFS } from '../engine/memfs.js'
import { mintRepoToken, repoRemote } from './artifacts.js'

const META_README = `# _meta

The blessed metadata branch. Issues, PRs, comments and CI results live here,
under .gild/ — never in the code branches. The forge validates and commits API
changes. Repository owners and organization admins may also push this branch;
those pushes fence and refresh the same access projection.
`

export async function initMeta(owner: string, repo: string, ownerKind: 'user' | 'org' = 'user', privateRepo=false,seedCode=true) {
  const fs = new MemFS()
  const dir = '/repo'

  await fs.mkdir(dir)
  await git.init({ fs: fs as never, dir, defaultBranch: 'main' })

  // Imports leave the valid Artifacts default branch unborn and push only
  // _meta. There is no synthetic code ref for the importer to delete.
  // (The index is empty — this is the empty tree, "just the branch".)
  if(seedCode) await git.commit({
    fs: fs as never,
    dir,
    ref: 'refs/heads/main',
    author: { name: 'gild', email: 'forge@gild.gg' },
    message: 'init',
  })

  const acl = JSON.stringify(
    ownerKind === 'org'
      ? { schema: 1, visibility:privateRepo?'private':'public', org: owner, owners: [], write: [], read: [] }
      : { schema: 1, visibility:privateRepo?'private':'public', owners: [`@${owner}`], write: [], read: [] },
    null,
    2,
  ) + '\n'
  await fs.mkdir(`${dir}/.gild`)
  await fs.writeFile(`${dir}/.gild/acl.json`, acl)
  await fs.writeFile(`${dir}/.gild/next`, '1\n')
  await fs.writeFile(`${dir}/README.md`, META_README)

  await git.add({ fs: fs as never, dir, filepath: '.gild/acl.json' })
  await git.add({ fs: fs as never, dir, filepath: '.gild/next' })
  await git.add({ fs: fs as never, dir, filepath: 'README.md' })
  await git.commit({
    fs: fs as never,
    dir,
    ref: 'refs/heads/_meta',
    author: { name: 'gild', email: 'forge@gild.gg' },
    message: 'init _meta: acl + counter',
  })

  // A just-created repo isn't token-mintable yet (409/403 while Artifacts
  // provisions it) — poll briefly.
  let minted
  for (let attempt = 0; ; attempt++) {
    try {
      minted = await mintRepoToken(owner, repo, 'write', 300)
      break
    } catch (e) {
      if (attempt >= 9) throw e
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  const remote = await repoRemote(owner, repo)
  const onAuth = () => ({ username: 'x', password: minted.plaintext.split('?')[0] })
  // Normal creation materializes the configured main branch.
  if(seedCode) await git.push({
    fs: fs as never,
    http,
    dir,
    url: remote,
    ref: 'main',
    remoteRef: 'main',
    onAuth,
  })
  const meta=await git.resolveRef({fs:fs as never,dir,ref:'_meta'})
  const st=await (await import('./backend.js')).store()
  await st.fenceRepoAccess(`${owner}/${repo}`,meta)
  await git.push({
    fs: fs as never,
    http,
    dir,
    url: remote,
    ref: '_meta',
    remoteRef: '_meta',
    onAuth,
  })
  await st.publishRepoAccess(`${owner}/${repo}`,meta,JSON.parse(acl))
}
