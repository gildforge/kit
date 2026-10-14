import {ApiError} from '../engine/api/errors.js'
import type {D1Database} from '@cloudflare/workers-types'
import {CONTENT_VERSION,type ContentEntry} from './prepared-repository-content.js'
import {SHA} from '../engine/api/ref-resolution.js'

/** Source adapter must run during hydration/ingestion/background preparation.
 * It supplies a FULL ready tree walk in existing Git order and actual rawBlob
 * sizes. Never call this from a page/HTTP GET. Tree closure is verified here;
 * hydrated blobs may arrive separately, without pretending missing bytes exist.
 * Parent hook: after snapshotReady(tree), use existing entries(index,tree,true)
 * plus actual object sizes, then publish; rawBlob completions publish blobs.
 * Imported pushes retain their existing suppressed wakeup until finish. */
export async function publishPreparedContentSnapshot(db:D1Database,id:string,input:{sha:string;tree:string;complete:true;entries:readonly ContentEntry[]}){
  if(!id||!SHA.test(input.sha)||!SHA.test(input.tree)||input.complete!==true||!Array.isArray(input.entries))
    throw new Error('Complete prepared content provenance required')
  if(input.entries.length>100000)throw new ApiError(413,'Content snapshot exceeds existing tree limit')
  const inventory:readonly ContentEntry[]=input.entries
  const paths=new Map<string,ContentEntry>(),directories=new Map<string,string>([['',input.tree]])
  for(const entry of inventory){
    if(!entry||!entry.path||entry.path.split('/').some(part=>!part||part==='.'||part==='..'||part.includes('\0'))
      ||paths.has(entry.path)||!SHA.test(entry.sha)||!['tree','blob','commit'].includes(entry.type)
      ||!/^[0-7]{5,6}$/.test(entry.mode)||!Number.isSafeInteger(entry.size)||entry.size<0
      ||entry.type!=='blob'&&entry.size!==0)
      throw new Error('Invalid prepared content inventory')
    paths.set(entry.path,entry)
    if(entry.type==='tree')directories.set(entry.path,entry.sha)
  }
  const parent=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):''
  for(const entry of inventory)if(!directories.has(parent(entry.path)))throw new Error('Incomplete prepared content tree closure')
  const statements=inventory.map((entry,ordinal)=>db.prepare(`INSERT INTO prepared_content_entries
    (id,version,sha,path,parent,name,kind,mode,object_sha,size,ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id,version,sha,path) DO NOTHING`).bind(id,CONTENT_VERSION,input.sha,entry.path,parent(entry.path),entry.path.split('/').at(-1)!,entry.type,entry.mode.padStart(6,'0'),entry.sha,entry.size,ordinal))
  const publishedTrees=new Map<string,string>()
  for(const [directory,sha] of directories){
    const prefix=directory?directory+'/':''
    for(const recursive of [0,1]){
      const entries=inventory.filter(entry=>recursive?entry.path.startsWith(prefix):parent(entry.path)===directory)
        .map(entry=>({...entry,path:entry.path.slice(prefix.length),mode:entry.mode.padStart(6,'0')}))
      const data=JSON.stringify(entries),key=sha+':'+recursive
      if(new TextEncoder().encode(data).length>700000)throw new ApiError(413,'Prepared tree exceeds individual value limit')
      if(publishedTrees.has(key)&&publishedTrees.get(key)!==data)throw new Error('Conflicting immutable tree inventory')
      publishedTrees.set(key,data)
      statements.push(db.prepare(`INSERT INTO prepared_content_trees VALUES (?,?,?,?,?)
        ON CONFLICT(id,version,sha,recursive) DO NOTHING`).bind(id,CONTENT_VERSION,sha,recursive,data))
    }
  }
  // Keep producer batches bounded, with the certificate LAST. A failed chunk
  // leaves only immutable partial object storage, never a ready snapshot. Exact
  // object-SHA reads can use a complete tree record already published earlier.
  for(let offset=0;offset<statements.length;offset+=80)await db.batch(statements.slice(offset,offset+80))
  await db.prepare('INSERT INTO prepared_content_snapshots VALUES (?,?,?,?) ON CONFLICT(id,version,sha) DO NOTHING')
    .bind(id,CONTENT_VERSION,input.sha,input.tree).run()
}

export async function publishPreparedContentBlob(db:D1Database,id:string,sha:string,blob:{size:number;content:string}){
  if(!id||!SHA.test(sha)||!Number.isSafeInteger(blob.size)||blob.size<0||typeof blob.content!=='string'
    ||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.content)
    ||atob(blob.content).length!==blob.size)throw new Error('Invalid prepared blob bytes or size')
  await db.prepare(`INSERT INTO prepared_content_blobs VALUES (?,?,?,?,?)
    ON CONFLICT(id,version,sha) DO NOTHING`).bind(id,CONTENT_VERSION,sha,blob.size,blob.content).run()
}
