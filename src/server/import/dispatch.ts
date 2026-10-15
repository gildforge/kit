import type { ImportJob } from './job.js'
import { sourceURL,type Forge } from '../../engine/import/source.js'

/** gild's import container has 1 GiB of memory and 4 GB of disk. A larger
 *  source imports from the owner's machine instead (`gild repo import`). */
export const SERVER_IMPORT_LIMIT=500*1024*1024

/** The source's size in bytes as its forge reports it, or null when the forge
 *  does not say (plain git, a private GitLab project without statistics). */
export async function sourceBytes(url:string,forge?:Forge,token?:string,fetcher:typeof fetch=fetch):Promise<number|null> {
  try {
    const source=sourceURL(url,forge)
    if(source.forge==='git')return null
    const headers:Record<string,string>={'user-agent':'gild-import',accept:'application/json'}
    if(token)headers[source.forge==='github'?'authorization':'private-token']=source.forge==='github'?'Bearer '+token:token
    const res=await fetcher(source.forge==='github'?source.api:source.api+'?statistics=true',{headers,signal:AbortSignal.timeout(5000)})
    if(!res.ok)return null
    const body=await res.json() as {size?:number;statistics?:{repository_size?:number}}
    // GitHub reports kilobytes; GitLab reports bytes.
    if(source.forge==='github')return typeof body.size==='number'?body.size*1024:null
    return typeof body.statistics?.repository_size==='number'?body.statistics.repository_size:null
  } catch {return null}
}
export function tooLargeMessage(bytes:number,repository:string) {
  return `Too large to import on gild's servers (${(bytes/1024**3).toFixed(1)} GB). Import it from your machine: gild repo resume ${repository}`
}
/** gild-import (services/import): runs a claimed import in a Container. */
export interface Importer { start(server:string,job:NonNullable<Awaited<ReturnType<ImportJob['claim']>>>):Promise<{started:string}> }

/** Claim a queued import and hand it to a gild-import container: no runner,
 *  nothing on the user's machine. Without the binding nothing is claimed and
 *  the CLI or an owner runner takes the job as before. A failed start keeps
 *  the claim; its lease lapses and the import DO's alarm dispatches again.
 *  Cost: one DO call (claim), one service call, one container start. */
export async function startImport(env:{IMPORTER?:Importer},server:string,claim:()=>Promise<Awaited<ReturnType<ImportJob['claim']>>>) {
  if(!env.IMPORTER) return false
  const payload=await claim()
  if(!payload) return false
  try {await env.IMPORTER.start(server,payload);return true}
  catch(e) {console.error('import dispatch failed',payload.repository,e instanceof Error?e.message:e);return false}
}
