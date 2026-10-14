import type {D1Database} from '@cloudflare/workers-types'
import type {Report} from './cqx-wasm.js'
import type {Change} from './changes.js'
import {CHANGE_VERSION} from '../engine/api/change-version.js'

export async function publishPreparedDiff(db:D1Database,id:string,kind:'commit'|'pull',target:string,
  head:string,base:string|null,meta:string|null,change:Change){
  const data={from:change.from,to:change.to,files:change.files,truncated:change.truncated,total:change.total,sizes:change.sizes}
  await db.prepare(`INSERT INTO prepared_repository_diffs VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id,version,kind,target) DO UPDATE SET head=excluded.head,base=excluded.base,meta=excluded.meta,data=excluded.data`)
    .bind(id,CHANGE_VERSION,kind,target,head,base,meta,JSON.stringify(data)).run()
}

export async function publishPreparedPullHeads(db:D1Database,id:string,epoch:number,meta:string|null,
  pulls:{number:number;head:string;base:string}[]){
  if(!id||!Number.isSafeInteger(epoch)||epoch<0||meta!==null&&typeof meta!=='string'||!Array.isArray(pulls))
    throw new Error('Invalid pull catalogue metadata')
  const numbers=new Set<number>()
  for(const pull of pulls){
    if(!pull||!Number.isSafeInteger(pull.number)||pull.number<1||numbers.has(pull.number)
      ||typeof pull.head!=='string'||!pull.head.trim()||typeof pull.base!=='string'||!pull.base.trim())
      throw new Error('Invalid pull catalogue membership or refs')
    numbers.add(pull.number)
  }
  // A ready receipt is published only after ALL bounded pages. Every row
  // and final receipt retain the captured push epoch, so interrupted/newer
  // generations cannot certify a partially written catalogue.
  for(let offset=0;offset<pulls.length;offset+=100)await db.batch([
    ...pulls.slice(offset,offset+100).map(pull=>db.prepare(`INSERT INTO prepared_pull_heads SELECT ?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM prepared_repository_refs WHERE id=? AND epoch=?)
      ON CONFLICT(id,number) DO UPDATE SET meta=excluded.meta,head_ref=excluded.head_ref,base_ref=excluded.base_ref`)
      .bind(id,pull.number,meta,pull.head,pull.base,id,epoch)),
  ])
  await db.prepare(`INSERT INTO prepared_pull_catalogues SELECT ?,? WHERE EXISTS
      (SELECT 1 FROM prepared_repository_refs WHERE id=? AND epoch=?)
      ON CONFLICT(id) DO UPDATE SET meta=excluded.meta`).bind(id,meta,id,epoch).run()
}

export async function publishPreparedHealth(db:D1Database,id:string,cacheKey:string,sha:string,report:Report|null,observedAt=Date.now()){
  const complete=report?.incomplete?0:1
  await db.prepare(`INSERT INTO prepared_repository_health VALUES (?,?,?,?,?,?)
    ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,complete=excluded.complete,observed_at=excluded.observed_at
    WHERE prepared_repository_health.complete=0 AND prepared_repository_health.observed_at<=excluded.observed_at`)
    .bind(cacheKey,id,sha,JSON.stringify(report),complete,observedAt).run()
}

export interface PreparedRefs {
  refs:{kind:'branch'|'tag';name:string;hash:string}[]
  defaultBranch:string
  meta:string|null|undefined
  ready:boolean
}
export async function fencePreparedRefs(db:D1Database,id:string){
  await db.prepare(`INSERT INTO prepared_repository_refs(id,epoch,pending) VALUES (?,1,1)
    ON CONFLICT(id) DO UPDATE SET epoch=prepared_repository_refs.epoch+1,pending=1`).bind(id).run()
}
/** Capture the fence BEFORE observing the local producer snapshot. A later
 * push cannot be cleared by the older publication after an awaited D1 write. */
export async function preparedRefsEpoch(db:D1Database,id:string){
  await db.prepare('INSERT OR IGNORE INTO prepared_repository_refs(id) VALUES (?)').bind(id).run()
  return (await db.prepare('SELECT epoch FROM prepared_repository_refs WHERE id=?').bind(id).first<{epoch:number}>())!.epoch
}
export async function publishPreparedRefs(db:D1Database,id:string,epoch:number,refs:PreparedRefs,observedAt=Date.now()){
  if(!refs.ready)return
  await db.prepare(`UPDATE prepared_repository_refs SET pending=0,meta=?,data=?,observed_at=?
    WHERE id=? AND epoch=?`).bind(refs.meta??null,JSON.stringify(refs),observedAt,id,epoch).run()
}
