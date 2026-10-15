import { getCloudflareContext } from '../context.js'
import { store } from '../backend.js'
import type { RepoImport } from './do.js'
export type ImportStub={ [K in 'address'|'create'|'status'|'claim'|'authorize'|'heartbeat'|'beginBatch'|'endBatch'|'finish'|'retry'|'cutover'|'local']: (...args:Parameters<RepoImport[K]>)=>Promise<Awaited<ReturnType<RepoImport[K]>>> }
export async function importJob(owner:string,repo:string):Promise<ImportStub> {
  const {env}=await getCloudflareContext(),ns=(env as unknown as {REPO_IMPORT:{idFromName(s:string):unknown;get(id:unknown):ImportStub}}).REPO_IMPORT
  const state=await (await store()).settings.state(`${owner}/${repo}`)
  const job=ns.get(ns.idFromName(state.id));await job.address(`${owner}/${repo}`);return job
}
