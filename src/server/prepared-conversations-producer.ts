import type {D1Database} from '@cloudflare/workers-types'
import type {Issue,Comment} from './issues.js'
import type {Pull,Review} from './pulls.js'
import type {InlineComment} from './api/metadata.js'
import {z} from 'zod'
import {provenance} from '../engine/api/import-contract.js'

export interface ConversationRepository {
  defaultBranch:string;description:string|null;stars:number;createdAt:string|null;updatedAt:string|null
}
export interface ConversationTicket {id:string;generation:string;epoch:number;meta:string|null;refs:string|null}
export type ConversationThread =
  {kind:'issue';item:Issue;updatedAt:string;comments:number;reviews:0} |
  {kind:'pr';item:Pull;updatedAt:string;comments:number;reviews:number;head:string;base:string}
export interface ConversationComment {number:number;kind:'issue'|'pr';ordinal:number;item:Comment|InlineComment}
export interface ConversationReview {number:number;ordinal:number;item:Review}
const count=z.number().int().nonnegative().safe(),positive=count.min(1),sha=z.string().regex(/^[a-f0-9]{40}$/)
const record=z.object({schema:z.literal(1),number:positive,title:z.string(),body:z.string(),author:z.string(),
  createdAt:z.string(),imported:provenance.optional()}).passthrough()
const issue=record.extend({state:z.enum(['open','closed']),labels:z.array(z.string()),claim:z.object({by:z.string(),at:z.string()}).nullable()})
const pull=record.extend({state:z.enum(['open','closed','merged']),head:z.string().min(1),base:z.string().min(1),labels:z.array(z.string()).optional(),
  conflicts:z.boolean().optional(),patchParts:count.optional(),merged:z.object({by:z.string(),at:z.string(),commit:sha}).optional()})
const comment=z.object({id:z.string().min(1),author:z.string(),body:z.string(),createdAt:z.string(),imported:provenance.optional()}).passthrough()
const inline=comment.extend({path:z.string().min(1),line:z.number().int(),side:z.enum(['LEFT','RIGHT']),commit_id:sha})
const review=comment.extend({verdict:z.enum(['approve','changes','comment']),headOid:sha.nullable()})
const repository=z.object({defaultBranch:z.string().min(1),description:z.string().nullable(),stars:count,createdAt:z.string().nullable(),updatedAt:z.string().nullable()})
function ticket(t:ConversationTicket){
  if(!t.id||!t.generation||!Number.isSafeInteger(t.epoch)||t.epoch<0||t.meta!==null&&typeof t.meta!=='string'||t.refs!==null&&typeof t.refs!=='string')throw new Error('Invalid conversation publication ticket')
}
const gate=`EXISTS (SELECT 1 FROM prepared_conversation_runs r JOIN prepared_repository_refs f ON f.id=r.id
  WHERE r.id=? AND r.generation=? AND r.epoch=? AND r.meta IS ? AND r.complete=0 AND f.epoch=r.epoch AND f.data IS r.refs)`
const bindings=(t:ConversationTicket)=>[t.id,t.generation,t.epoch,t.meta]
function page(items:unknown[]){if(items.length>100)throw new Error('Stage at most 100 conversation rows per batch')}

/** Called only by ingestion/background, after observing COMPLETE inventory.
 * Expected counts cover every source page, not a truncated first page. */
export async function beginPreparedConversations(db:D1Database,t:ConversationTicket,repo:ConversationRepository,
  expected:{threads:number;comments:number;reviews:number}){
  ticket(t);const checked=repository.parse(repo);count.parse(expected.threads);count.parse(expected.comments);count.parse(expected.reviews)
  // Retry the exact captured generation, never a changed observation under the
  // same generation. Staging is idempotent and finalized runs are immutable.
  await db.prepare(`INSERT INTO prepared_conversation_runs SELECT ?,?,?,?,?,?,?,?,0,? WHERE EXISTS
    (SELECT 1 FROM prepared_repository_refs WHERE id=? AND epoch=? AND data IS ?) ON CONFLICT(id,generation) DO NOTHING`)
    .bind(t.id,t.generation,t.epoch,t.meta,JSON.stringify(checked),expected.threads,expected.comments,expected.reviews,t.refs,t.id,t.epoch,t.refs).run()
  const captured=await db.prepare(`SELECT r.epoch,r.meta,r.repository,r.threads,r.comments,r.reviews,r.refs FROM prepared_conversation_runs r
    JOIN prepared_repository_refs f ON f.id=r.id AND f.epoch=r.epoch AND f.data IS r.refs WHERE r.id=? AND r.generation=?`)
    .bind(t.id,t.generation).first<{epoch:number;meta:string|null;repository:string;threads:number;comments:number;reviews:number;refs:string|null}>()
  if(!captured)return false
  if(captured.epoch!==t.epoch||captured.meta!==t.meta||captured.refs!==t.refs||captured.repository!==JSON.stringify(checked)
    ||captured.threads!==expected.threads||captured.comments!==expected.comments||captured.reviews!==expected.reviews)
    throw new Error('Conversation generation cannot describe a different inventory')
  return true
}
export async function stagePreparedConversationThreads(db:D1Database,t:ConversationTicket,items:ConversationThread[]){
  ticket(t);page(items)
  if(!items.length)return
  const seen=new Set<string>()
  for(const row of items){
    (row.kind==='issue'?issue:pull).parse(row.item);count.parse(row.comments);count.parse(row.reviews)
    if(row.kind==='issue'&&row.reviews!==0)throw new Error('Issues cannot have pull reviews')
    if(row.kind==='pr'){sha.parse(row.head);sha.parse(row.base)}
    z.string().parse(row.updatedAt)
    const key=row.kind+':'+row.item.number;if(seen.has(key))throw new Error('Duplicate conversation thread');seen.add(key)
  }
  await db.batch(items.map(row=>db.prepare(`INSERT INTO prepared_conversation_threads SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${gate}
    ON CONFLICT(id,generation,number,kind) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,
    comments=excluded.comments,reviews=excluded.reviews,labels=excluded.labels,data=excluded.data,head=excluded.head,base=excluded.base`)
    .bind(t.id,t.generation,row.item.number,row.kind,row.item.state,row.updatedAt,row.comments,row.reviews,
      JSON.stringify(row.item.labels??[]),JSON.stringify(row.item),row.kind==='pr'?row.head:null,row.kind==='pr'?row.base:null,...bindings(t))))
}
export async function stagePreparedConversationComments(db:D1Database,t:ConversationTicket,items:ConversationComment[]){
  ticket(t);page(items);const seen=new Set<string>()
  if(!items.length)return
  for(const row of items){
    positive.parse(row.number);count.parse(row.ordinal);z.enum(['issue','pr']).parse(row.kind)
    if('path' in row.item){if(row.kind!=='pr')throw new Error('Inline comments require a pull');inline.parse(row.item)}else comment.parse(row.item)
    const key=row.kind+':'+row.number+':'+row.item.id;if(seen.has(key))throw new Error('Duplicate conversation comment');seen.add(key)
  }
  await db.batch(items.map(row=>db.prepare(`INSERT INTO prepared_conversation_comments SELECT ?,?,?,?,?,?,?,? WHERE ${gate}
    ON CONFLICT(id,generation,number,kind,source_id) DO UPDATE SET ordinal=excluded.ordinal,inline=excluded.inline,data=excluded.data`)
    .bind(t.id,t.generation,row.number,row.kind,row.item.id,row.ordinal,'path' in row.item?1:0,JSON.stringify(row.item),...bindings(t))))
}
export async function stagePreparedConversationReviews(db:D1Database,t:ConversationTicket,items:ConversationReview[]){
  ticket(t);page(items);const seen=new Set<string>()
  if(!items.length)return
  for(const row of items){positive.parse(row.number);count.parse(row.ordinal);review.parse(row.item)
    const key=row.number+':'+row.item.id;if(seen.has(key))throw new Error('Duplicate conversation review');seen.add(key)}
  await db.batch(items.map(row=>db.prepare(`INSERT INTO prepared_conversation_reviews SELECT ?,?,?,?,?,? WHERE ${gate}
    ON CONFLICT(id,generation,number,source_id) DO UPDATE SET ordinal=excluded.ordinal,data=excluded.data`)
    .bind(t.id,t.generation,row.number,row.item.id,row.ordinal,JSON.stringify(row.item),...bindings(t))))
}
/** A single primary-D1 transaction certifies inventory and all children, then
 * publishes it only if the original epoch AND current ACL metadata still match.
 * Old completion cannot clear a new push's fence; incomplete runs stay Pending. */
export async function finishPreparedConversations(db:D1Database,t:ConversationTicket){
  ticket(t)
  await db.batch([
    db.prepare(`UPDATE prepared_conversation_runs AS r SET complete=1 WHERE r.id=? AND r.generation=? AND r.epoch=? AND r.meta IS ?
      AND EXISTS (SELECT 1 FROM prepared_repository_refs f WHERE f.id=r.id AND f.epoch=r.epoch AND f.pending=0 AND f.meta IS r.meta AND f.data IS r.refs)
      AND r.threads=(SELECT count(*) FROM prepared_conversation_threads a WHERE a.id=r.id AND a.generation=r.generation)
      AND r.comments=(SELECT count(*) FROM prepared_conversation_comments a WHERE a.id=r.id AND a.generation=r.generation)
      AND r.reviews=(SELECT count(*) FROM prepared_conversation_reviews a WHERE a.id=r.id AND a.generation=r.generation)
      AND NOT EXISTS (SELECT 1 FROM prepared_conversation_threads a WHERE a.id=r.id AND a.generation=r.generation AND
        (a.comments!=(SELECT count(*) FROM prepared_conversation_comments c WHERE c.id=a.id AND c.generation=a.generation AND c.number=a.number AND c.kind=a.kind)
         OR a.reviews!=(SELECT count(*) FROM prepared_conversation_reviews v WHERE v.id=a.id AND v.generation=a.generation AND v.number=a.number AND a.kind='pr')))
      AND NOT EXISTS (SELECT 1 FROM prepared_conversation_comments c WHERE c.id=r.id AND c.generation=r.generation AND NOT EXISTS
        (SELECT 1 FROM prepared_conversation_threads a WHERE a.id=c.id AND a.generation=c.generation AND a.number=c.number AND a.kind=c.kind))
      AND NOT EXISTS (SELECT 1 FROM prepared_conversation_reviews v WHERE v.id=r.id AND v.generation=r.generation AND NOT EXISTS
        (SELECT 1 FROM prepared_conversation_threads a WHERE a.id=v.id AND a.generation=v.generation AND a.number=v.number AND a.kind='pr'))`)
      .bind(...bindings(t)),
    db.prepare(`INSERT INTO prepared_conversation_receipts SELECT r.id,r.generation,r.epoch,r.meta FROM prepared_conversation_runs r
      JOIN prepared_repository_refs f ON f.id=r.id WHERE r.id=? AND r.generation=? AND r.epoch=? AND r.meta IS ?
      AND r.complete=1 AND f.epoch=r.epoch AND f.pending=0 AND f.meta IS r.meta AND f.data IS r.refs
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,epoch=excluded.epoch,meta=excluded.meta`)
      .bind(...bindings(t)),
  ])
  return !!await db.prepare(`SELECT 1 AS ready FROM prepared_conversation_receipts c JOIN prepared_conversation_runs r ON r.id=c.id AND r.generation=c.generation JOIN prepared_repository_refs f
    ON f.id=c.id AND f.epoch=c.epoch AND f.pending=0 AND f.meta IS c.meta AND f.data IS r.refs
    WHERE c.id=? AND c.generation=? AND c.epoch=? AND c.meta IS ?`)
    .bind(...bindings(t)).first()
}

/** Background-only bounded retirement. Preserve the active receipt and any
 * current unfinished generation; abandoned old-epoch staging is safe to drop. */
export async function prunePreparedConversations(db:D1Database,id:string,limit=10){
  if(!id||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error('Invalid conversation retirement batch')
  const rows=(await db.prepare(`SELECT r.generation FROM prepared_conversation_runs r
    JOIN prepared_repository_refs f ON f.id=r.id
    WHERE r.id=? AND (r.complete=1 OR r.epoch<f.epoch)
    AND NOT EXISTS (SELECT 1 FROM prepared_conversation_receipts c WHERE c.id=r.id AND c.generation=r.generation)
    ORDER BY r.epoch,r.generation LIMIT ?`).bind(id,limit).all<{generation:string}>()).results
  if(!rows.length)return 0
  await db.batch(rows.flatMap(row=>['prepared_conversation_comments','prepared_conversation_reviews','prepared_conversation_threads','prepared_conversation_runs']
    .map(table=>db.prepare(`DELETE FROM ${table} WHERE id=? AND generation=? AND NOT EXISTS
      (SELECT 1 FROM prepared_conversation_receipts WHERE id=? AND generation=?)`)
      .bind(id,row.generation,id,row.generation))))
  return rows.length
}
