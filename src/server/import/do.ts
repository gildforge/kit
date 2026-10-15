import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState,D1Database } from '@cloudflare/workers-types'
import { ImportJob } from './job.js'
import { startImport, type Importer } from './dispatch.js'
/** Container starts per queued import before it waits for an owner runner. */
const DISPATCHES=3
export class RepoImport extends DurableObject<{DB:D1Database;ACTIONS_SECRET_KEY?:string;IMPORTER?:Importer;PUBLIC_ORIGIN?:string;RUNNER_POOL:{idFromName(s:string):unknown;get(id:unknown):{completed(id:string,lease:string):Promise<void>;touch(id:string):Promise<void>}}}> {
  private job:ImportJob
  constructor(ctx:DurableObjectState,env:{DB:D1Database;ACTIONS_SECRET_KEY?:string;IMPORTER?:Importer;PUBLIC_ORIGIN?:string;RUNNER_POOL:{idFromName(s:string):unknown;get(id:unknown):{completed(id:string,lease:string):Promise<void>;touch(id:string):Promise<void>}}}) {super(ctx as never,env);this.job=new ImportJob(ctx.storage as never,env)}
  private async publish() {
    const j=await this.ctx.storage.get<import('./job.js').Job>('job');if(!j)return
    await this.env.DB.prepare('INSERT OR REPLACE INTO repo_imports(repository,state,updated,internal_prefix) VALUES (?,?,?,?)').bind(j.repository,j.state,j.updated,j.internalPrefix??'import/pr').run()
  }
  private async mutate<T>(work:()=>Promise<T>) { return this.ctx.blockConcurrencyWhile(async()=>{
    const before=await this.ctx.storage.get<import('./job.js').Job>('job')
    const result=await work();await this.publish()
    const after=await this.ctx.storage.get<import('./job.js').Job>('job')
    if(before?.state==='running' && after?.state!=='running' && before.runner) {
      const st=(await import('../drivers/d1.js')).d1Store(this.env.DB),state=await st.settings.state(before.runner.owner)
      await this.env.RUNNER_POOL.get(this.env.RUNNER_POOL.idFromName(state.id)).completed(before.runner.id,before.runner.lease)
    }
    return result
  }) }
  create(...a:Parameters<ImportJob['create']>) {return this.mutate(()=>this.job.create(...a))}
  async address(repository:string) {
    const before=await this.ctx.storage.get<import('./job.js').Job>('job');if(!before || before.repository===repository)return
    await this.mutate(()=>this.job.address(repository))
    if(before.repository!==repository)await this.env.DB.prepare('DELETE FROM repo_imports WHERE repository=?').bind(before.repository).run()
  }
  suspend() {return this.mutate(async()=>{if(await this.ctx.storage.get('job'))await this.job.suspend()})}
  async purge() {const j=await this.ctx.storage.get<import('./job.js').Job>('job');await this.suspend();await this.ctx.storage.deleteAlarm();await this.ctx.storage.deleteAll();if(j)await this.env.DB.prepare('DELETE FROM repo_imports WHERE repository=?').bind(j.repository).run()}
  status() {return this.job.status()}
  authorize(...a:Parameters<ImportJob['authorize']>) {return this.job.authorize(...a)}
  claim(...a:Parameters<ImportJob['claim']>) {return this.mutate(()=>this.job.claim(...a))}
  heartbeat(...a:Parameters<ImportJob['heartbeat']>) {return this.mutate(async()=>{const result=await this.job.heartbeat(...a);const j=await this.ctx.storage.get<import('./job.js').Job>('job');if(j?.runner){const st=(await import('../drivers/d1.js')).d1Store(this.env.DB),state=await st.settings.state(j.runner.owner);await this.env.RUNNER_POOL.get(this.env.RUNNER_POOL.idFromName(state.id)).touch(j.runner.id)}return result})}
  beginBatch(...a:Parameters<ImportJob['beginBatch']>) {return this.mutate(()=>this.job.beginBatch(...a))}
  endBatch(...a:Parameters<ImportJob['endBatch']>) {return this.mutate(()=>this.job.endBatch(...a))}
  async finish(...a:Parameters<ImportJob['finish']>) {const r=await this.mutate(()=>this.job.finish(...a));await this.ctx.storage.delete('dispatches');return r}
  async retry(...a:Parameters<ImportJob['retry']>) {const r=await this.mutate(()=>this.job.retry(...a));await this.ctx.storage.delete('dispatches');return r}
  /** The alarm's retry: a container that never reported let its lease lapse
   *  and the job is queued again. At most DISPATCHES starts per import; then
   *  an owner runner can still claim it. */
  private async dispatch() {
    const tries=(await this.ctx.storage.get<number>('dispatches'))??0
    if(!this.env.IMPORTER || !this.env.PUBLIC_ORIGIN || tries>=DISPATCHES) return
    await this.ctx.storage.put('dispatches',tries+1)
    await startImport(this.env,this.env.PUBLIC_ORIGIN,()=>this.claim())
  }
  /** Keep this import off the container: it waits for the CLI or an owner runner. */
  async local(message:string) {
    await this.ctx.storage.put('dispatches',DISPATCHES)
    await this.mutate(async()=>{const j=await this.ctx.storage.get<import('./job.js').Job>('job');if(j?.state==='queued')await this.ctx.storage.put('job',{...j,local:true,progress:{...j.progress,message}})})
  }
  cutover() {return this.mutate(()=>this.job.cutover())}
  async alarm() {
    await this.mutate(()=>this.job.alarm())
    if((await this.ctx.storage.get<import('./job.js').Job>('job'))?.state==='queued') await this.dispatch()
  }
}
