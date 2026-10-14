import type { ImportJob } from './job.js'
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
