import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { mintRepoToken,repoRemote } from '../artifacts.js'
import { writeMeta,writeJson,readJson,DIR } from '../metastore.js'
import type { MemFS } from '../../engine/memfs.js'
import type { Pull } from '../pulls.js'

/** Seal PR heads as immutable commits reachable from _meta before removing
 * temporary refs. Retrying after any deletion is safe: the sealing commit is
 * already durable and each remaining ref is discovered afresh. */
export async function finishImportRefs(owner:string,repo:string,prefix:string,summary:unknown) {
  const {plaintext}=await mintRepoToken(owner,repo,'write',300),url=await repoRemote(owner,repo)
  const headers={authorization:'Bearer '+plaintext}
  const refs=(await git.listServerRefs({http,url,headers})).filter(r=>r.ref.startsWith('refs/heads/'+prefix+'/'))
  const parents=[...new Set(refs.map(r=>r.oid))]
  await writeMeta(owner,repo,'Record import summary',owner,async fs=>{
    // The advertised heads already exist upstream. git push excludes those
    // advertised OIDs from its pack, so pinning needs no PR code download.
    await sealImportPulls(fs,refs)
    await writeJson(fs,`${DIR}/.gild/import/source.json`,summary)
    return true
  },{codeRefs:{},historical:true,parents})
  // Use the upstream transport; ordinary users cannot mutate import refs.
  for(const ref of refs) {
    const fs=new (await import('../../engine/memfs.js')).MemFS()
    await git.init({fs:fs as never,dir:DIR})
    await git.writeRef({fs:fs as never,dir:DIR,ref:ref.ref,value:ref.oid})
    const result=await git.push({fs:fs as never,http,dir:DIR,url,headers,ref:ref.ref,remoteRef:ref.ref,delete:true})
    if(!result.ok)throw Error('Could not remove temporary import ref')
  }
}
export async function sealImportPulls(fs:MemFS,refs:{ref:string;oid:string}[]) {
  for(const ref of refs) {
    const number=ref.ref.split('/').at(-1)
    if(!/^[1-9][0-9]*$/.test(number??''))continue
    const path=`${DIR}/.gild/${number}/pr/pr.json`,pull=await readJson<Pull>(fs,path)
    if(pull?.imported && pull.head===ref.ref.slice(11))await writeJson(fs,path,{...pull,head:ref.oid})
  }
}
