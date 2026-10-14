import { encrypt, decrypt } from '../actions/secrets.js'
import { sourceURL, type Forge } from '../../engine/import/source.js'
import type { z } from 'zod'
import type { importInput, importProgress, importSummary } from '../../engine/api/import-contract.js'
export interface JobStorage { get<T>(key:string):Promise<T|undefined>; put(key:string,value:unknown):Promise<void>; setAlarm(at:number):Promise<void>; deleteAlarm():Promise<void> }
type Progress=z.infer<typeof importProgress>
export interface Job {
  internalPrefix?:string; summary?:z.infer<typeof importSummary>; by?:string; repository:string; source:string; forge:Forge; mirror:boolean;
  state:'queued'|'running'|'complete'|'mirroring'|'failed'|'cutover';
  progress:Progress; warnings:string[]; error:string|null;
  updated:number; next:number|null; cipher:string|null;
  runner?:{owner:string;id:string;lease:string}; leaseHash:string|null; expires:number; checkpoint:string; busy:boolean;
}
export const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('')
export class ImportJob {
  readonly storage:JobStorage
  readonly env:{ACTIONS_SECRET_KEY?:string}
  readonly now:()=>number
  constructor(storage:JobStorage,env:{ACTIONS_SECRET_KEY?:string},now=()=>Date.now()) {this.storage=storage;this.env=env;this.now=now}
  async read() { const job=await this.storage.get<Job>('job');if(!job) throw Object.assign(Error('Import not found'),{status:404});return job }
  async save(job:Job) {job.updated=this.now();await this.storage.put('job',job);if(job.next!==null) await this.storage.setAlarm(job.next)}
  async create(repository:string,input:z.infer<typeof importInput>,by?:string) {
    if(await this.storage.get('job')) throw Object.assign(Error('Import already exists'),{status:409})
    const source=sourceURL(input.url,input.forge)
    const cipher=input.source_token?await encrypt(this.env,`import:${repository}`,input.source_token):null
    const job:Job={by,repository,source:source.url,forge:source.forge,mirror:input.mirror,state:'queued',progress:{phase:'git',completed:0,message:'Waiting for the CLI or an eligible owner runner'},warnings:[],error:null,updated:this.now(),next:this.now()+60000,cipher,leaseHash:null,expires:0,checkpoint:'',busy:false}
    await this.save(job)
    return this.status()
  }
  async status() {
    const j=await this.read()
    return {repository:j.repository,source:j.source,mirror:j.mirror,state:j.state,progress:j.progress,warnings:j.warnings,error:j.error,updated_at:new Date(j.updated).toISOString(),next_sync:j.next?new Date(j.next).toISOString():null,summary:j.summary}
  }
  async claim(runner?:Job["runner"]) {
    const j=await this.read()
    if(j.state!=='queued') return null
    const token='gi_'+crypto.randomUUID().replaceAll('-','')
    j.runner=runner;j.state='running';j.progress={...j.progress,message:runner?'Claimed by an owner runner':'Importing'};j.leaseHash=await hash(token);j.expires=this.now()+120000;j.next=j.expires;j.error=null
    await this.save(j)
    return {repository:j.repository,source:j.source,forge:j.forge,mirror:j.mirror,token,checkpoint:j.checkpoint,...(j.cipher?{source_token:await decrypt(this.env,`import:${j.repository}`,j.cipher)}:{})}
  }
  async authorize(token:string) {
    const j=await this.read()
    if(j.state!=='running' || j.expires<=this.now() || j.leaseHash!==await hash(token)) throw Object.assign(Error('Import lease expired or revoked'),{status:401})
    return j
  }
  async heartbeat(token:string,progress?:Progress) {
    const j=await this.authorize(token)
    if(progress) {j.internalPrefix=progress.internal_prefix??j.internalPrefix;j.progress={...progress,checkpoint:undefined}}
    j.expires=this.now()+120000;j.next=j.expires;await this.save(j)
    return this.status()
  }
  async beginBatch(token:string) {
    const j=await this.authorize(token)
    if(j.busy) throw Object.assign(Error('Import batch already running'),{status:409})
    j.busy=true;await this.save(j)
  }
  async endBatch(token:string,progress?:Progress) {
    const j=await this.authorize(token)
    j.busy=false
    if(progress) {j.checkpoint=progress.checkpoint??j.checkpoint;j.progress={...progress,checkpoint:undefined}}
    j.expires=this.now()+120000;j.next=j.expires;await this.save(j)
  }
  async finish(token:string,warnings:string[],error?:string,summary?:z.infer<typeof importSummary>) {
    const j=await this.authorize(token)
    if(j.busy) throw Object.assign(Error('Import batch still running'),{status:409})
    j.state=error?'failed':j.mirror?'mirroring':'complete'
    // Error details are fixed public messages; never persist arbitrary subprocess output.
    j.error=error?'Import interrupted; check source access and resume the job':null
    if(summary)j.summary=summary
    j.progress.message=error?'Import interrupted':'Import complete'
    j.warnings=warnings;j.leaseHash=null;j.expires=0
    j.next=j.mirror?this.now()+(error?300000:3600000):null
    if(!j.mirror) j.cipher=null
    if(!error) j.checkpoint=''
    await this.save(j)
    if(j.next===null) await this.storage.deleteAlarm()
    return this.status()
  }
  async retry(sourceToken?:string) {
    const j=await this.read()
    if(j.state==='running' || j.state==='cutover') throw Object.assign(Error('Import cannot be resumed in this state'),{status:409})
    if(sourceToken) j.cipher=await encrypt(this.env,`import:${j.repository}`,sourceToken)
    j.state='queued';j.next=this.now()+60000;j.error=null;await this.save(j)
    return this.status()
  }
  async cutover() {
    const j=await this.read()
    if(j.state==='running') throw Object.assign(Error('Wait for the running import to finish before cutover'),{status:409})
    // A mirror that synced once can always be cut over, even while its source is down.
    const synced=j.mirror&&!!j.summary&&['failed','queued'].includes(j.state)
    if(!synced&&!['complete','mirroring','cutover'].includes(j.state)) throw Object.assign(Error('Complete an import before cutover'),{status:409})
    j.state='cutover';j.mirror=false;j.cipher=null;j.leaseHash=null;j.next=null;await this.save(j);await this.storage.deleteAlarm()
    return this.status()
  }
  async address(repository:string) {
    const j=await this.storage.get<Job>('job')
    if(!j || j.repository===repository) return
    if(j.cipher) j.cipher=await encrypt(this.env,`import:${repository}`,await decrypt(this.env,`import:${j.repository}`,j.cipher))
    j.repository=repository;await this.save(j)
  }
  async suspend() {
    const j=await this.storage.get<Job>('job');if(!j)return
    j.state='failed';j.mirror=false;j.cipher=null;j.leaseHash=null;j.next=null;j.busy=false;j.error='Repository is read-only; restore it before resuming'
    await this.save(j);await this.storage.deleteAlarm()
  }
  async alarm() {
    const j=await this.read(),now=this.now()
    if(j.state==='running' && j.expires<=now) {j.state='queued';j.leaseHash=null;j.busy=false}
    else if((j.state==='mirroring'||j.state==='failed') && j.mirror && (j.next??Infinity)<=now) {if(j.state==='mirroring')j.checkpoint='';j.state='queued'}
    j.next=j.state==='queued'?now+60000:j.state==='running'?j.expires:j.next
    await this.save(j)
  }
}
