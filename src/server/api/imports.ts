import { getCloudflareContext } from '../context.js'
import { destinationPrivate } from '../../engine/import/fence.js'
import { sourceURL } from '../../engine/import/source.js'
import { importJob } from '../import/service.js'
import { startImport,sourceBytes,SERVER_IMPORT_LIMIT,tooLargeMessage } from '../import/dispatch.js'
import { store } from '../backend.js'
import { mayWrite } from '../access.js'
import { ApiError } from '../../engine/api/errors.js'
import { createRepository } from '../repos-write.js'
import { encrypt } from '../actions/secrets.js'
import { runnerPool } from '../actions/pool-service.js'
import { writeImportBatch } from '../import/write.js'
import { workflowWarnings } from '../../engine/import/workflows.js'
import { readyIndex,scheduleIndex } from '../repo-index.js'
import type { Context,Result } from './dispatch.js'
import type { D1Database } from '@cloudflare/workers-types'
export async function authorizeImport(c:Context) {
  if(c.principal.id.startsWith('import:')) return // Capability already verified against this exact job.
  if(['importStatus','importPatch'].includes(c.route.id))return // Dispatcher enforces shared repository read access.
  if(['importUserPoll','importOrgPoll'].includes(c.route.id)) return // Handler authenticates owner runner.
  const owner=c.params.owner ?? c.params.org ?? c.principal.name
  if(c.principal.name.includes('/') || !(await mayWrite(owner,c.principal.name))) throw new ApiError(403,'Repository owner or organization admin required')
  if(c.principal.repos!==null && !c.params.repo) throw new ApiError(403,'Repository creation requires an unrestricted token')
}
/** False (and the job marked for the CLI) when the source is too large for
 *  the import container. An unknown size goes to the container as before. */
async function serverSized(job:Awaited<ReturnType<typeof importJob>>,repository:string,url:string,forge?:Parameters<typeof sourceBytes>[1],token?:string) {
  const bytes=await sourceBytes(url,forge,token)
  if(bytes===null||bytes<=SERVER_IMPORT_LIMIT) return true
  await job.local(tooLargeMessage(bytes,repository))
  return false
}
export async function apiImports(c:Context):Promise<Result> {
  const b=c.body,id=c.route.id,st=await store(),{env}=await getCloudflareContext(),token=c.request.headers.get('authorization')?.replace(/^Bearer /i,'')??''
  if(id==='importCreate'||id==='importOrgCreate') {
    // Explicit CLI owner/name targets use this route for users as well as orgs.
    // createRepository resolves the owner kind from the store, not the URL.
    const source=sourceURL(b.url,b.forge),owner=c.params.org??c.principal.name,name=b.name??source.name.toLowerCase()
    if(b.source_token && new URL(source.url).protocol==='http:') throw new ApiError(422,'Use HTTPS or SSH with a source token')
    // Validate encryption before provisioning anything. Plaintext never enters durable storage.
    if(b.source_token) await encrypt(env as {ACTIONS_SECRET_KEY?:string},`import:${owner}/${name}`,b.source_token)
    const isPrivate=destinationPrivate(b)
    await createRepository(c.principal.name,owner,name,undefined,isPrivate,false)
    const job=await importJob(owner,name)
    const created=await job.create(`${owner}/${name}`,{url:source.url,name:b.name,private:isPrivate,mirror:b.mirror,source_token:b.source_token,forge:b.forge},c.principal.name)
    // Straight from the source into Artifacts, server-side (services/import).
    // `x-gild-import-runner: local` keeps the job for the caller's own machine.
    if(c.request.headers.get('x-gild-import-runner')==='local') return {data:created}
    if(!await serverSized(job,`${owner}/${name}`,source.url,source.forge,b.source_token)) return {data:await job.status()}
    return {data:await startImport(env as never,new URL(c.request.url).origin,()=>job.claim())?await job.status():created}
  }
  if(id==='importUserPoll'||id==='importOrgPoll') {
    const owner=c.params.org??c.params.name,pool=await runnerPool(owner,c.params.org?'org':'user')
    const runner=await pool.authenticate(token)
    await pool.touch(runner.id)
    if(runner.assignment) return {data:null}
    const db=(env as unknown as {DB:D1Database}).DB
    const rows=(await db.prepare("SELECT repository FROM repo_imports WHERE state='queued' AND repository LIKE ? ORDER BY updated LIMIT 100").bind(owner+'/%').all<{repository:string}>()).results
    for(const row of rows) {
      if(!await pool.candidate(runner.id,row.repository)) continue
      const lease='import:'+crypto.randomUUID(),reserved=await pool.reserveImport(token,row.repository,lease)
      if(!reserved) return {data:null}
      const [o,r]=row.repository.split('/')
      try {
        const data=await (await importJob(o,r)).claim({owner,id:runner.id,lease})
        if(data) return {data}
      } finally {
        const status=await (await importJob(o,r)).status()
        if(status.state!=='running') await pool.completed(runner.id,lease)
      }
    }
    return {data:null}
  }
  const {owner,repo}=c.params,job=await importJob(owner,repo)
  if(id==='importStatus') return {data:await job.status()}
  if(id==='importClaim') return {data:await job.claim()}
  if(id==='importRetry') {const queued=await job.retry(b.source_token)
    if(!await serverSized(job,`${owner}/${repo}`,queued.source,undefined,b.source_token)) return {data:await job.status()}
    return {data:await startImport(env as never,new URL(c.request.url).origin,()=>job.claim())?await job.status():queued}}
  if(id==='importCutover') {
    const result=await job.cutover()
    const {writeMeta,writeJson,DIR}=await import('../metastore.js')
    await writeMeta(owner,repo,'Cut over imported repository',c.principal.name,async fs=>{await writeJson(fs,`${DIR}/.gild/import/source.json`,{url:result.source,readOnly:true,cutoverAt:result.updated_at});return true},{codeRefs:{},historical:true})
    return {data:result}
  }
  if(id==='importPatch') {
    const index=await readyIndex(owner,repo),raw=await index?.metaFile(`.gild/${c.params.number}/pr/pr.json`)
    const parts=raw?JSON.parse(raw).patchParts:0
    if(!parts) throw new ApiError(404,'No imported patch')
    let part=0
    const stream=new ReadableStream<Uint8Array>({async pull(controller){if(part>=parts){controller.close();return}try{const text=await index!.metaFile(`.gild/${c.params.number}/pr/patch-${String(part++).padStart(6,'0')}.patch`);if(text===null) throw Error('Patch missing');controller.enqueue(new TextEncoder().encode(text))}catch(e){controller.error(e)}}})
    return {data:null,response:new Response(stream,{headers:{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="import-${c.params.number}.patch"`}})}
  }
  const active=await job.authorize(token)
  if(id==='importCredentials') {
    const state=await st.settings.state(`${owner}/${repo}`),org=await st.settings.state(owner)
    if(state.archived || state.deletedAt!==null || state.moving || org.archived || org.deletedAt!==null || org.moving) throw new ApiError(409,'Repository is read-only')
    return {data:{url:new URL(`/${owner}/${repo}.git`,c.request.url).toString(),token}}
  }
  if(id==='importHeartbeat') {
    if(b.progress?.default_branch) {const state=await st.settings.state(`${owner}/${repo}`);await st.settings.putState({...state,defaultBranch:b.progress.default_branch})}
    return {data:await job.heartbeat(token,b.progress)}
  }
  if(id==='importWorkflow') return {data:{warnings:workflowWarnings(b.file,b.text)}}
  if(id==='importBatch') {
    await job.beginBatch(token)
    try {await writeImportBatch(owner,repo,owner,b.records);await job.endBatch(token,b.progress)} catch(e) {await job.endBatch(token).catch(()=>{});throw e}
    return {data:{ok:true}}
  }
  if(id==='importFinish') {
    if(!b.error && b.default_branch) {const state=await st.settings.state(`${owner}/${repo}`);await st.settings.putState({...state,defaultBranch:b.default_branch})}
    const finished=await job.finish(token,b.warnings,b.error,b.summary)
    // The repository is all there: finishing its import refs and summary and
    // re-indexing take tens of seconds, longer than an importer waits for an
    // answer, so they run after it (a failure is logged; the data stays).
    if(!b.error) {
      // Wake the index first: it is durable (a Durable Object alarm), while the
      // waitUntil below may be cut off after ~30s and never reach its wake.
      await scheduleIndex(owner,repo)
      const work=(async()=>{
        const { finishImportRefs } = await import('../import/finish.js')
        await finishImportRefs(owner,repo,active.internalPrefix??'import/pr',{url:active.source,mirror:active.mirror,readOnly:false,warnings:b.warnings,summary:b.summary})
        await scheduleIndex(owner,repo)
      })().catch(e=>console.error('Import finishing failed',owner,repo,e instanceof Error?e.message:e))
      ;(await getCloudflareContext()).ctx.waitUntil(work)
    }
    return {data:finished}
  }
  void active
  throw new ApiError(404,'Not Found')
}
