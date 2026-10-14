import {ApiError} from './api/errors.js'
import {CHANGE_VERSION} from './api/change-version.js'

export interface WalkRef {kind:'branch'|'tag';name:string;hash:string}
export interface WalkPull {number:number;head:string;base:string}
export class PreparationQueueFull extends ApiError {constructor(){super(503,'Diff preparation is busy')}}
interface WalkState {generation:string;refs:number;pulls:number}
/** Bounded producer continuation. Persist this state in the owning index;
 * changing code/metadata/version starts a new pass rather than inheriting an
 * unrelated cursor. No request or GET preparation port is involved. */
export async function preparedChangePage(refs:WalkRef[],pulls:WalkPull[],meta:string|null,previous:string|null|undefined,size=100){
  if(!Number.isSafeInteger(size)||size<1||size>100)throw new Error('Invalid preparation page size')
  const generation=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([CHANGE_VERSION,meta,refs,pulls])))).toString('hex')
  let saved:WalkState|undefined
  try { saved=previous?JSON.parse(previous):undefined }catch{}
  const valid=saved?.generation===generation&&Number.isSafeInteger(saved.refs)&&saved.refs>=0&&saved.refs<=refs.length
    &&Number.isSafeInteger(saved.pulls)&&saved.pulls>=0&&saved.pulls<=pulls.length
  const start=valid?saved!:{generation,refs:0,pulls:0}
  const refCount=Math.min(size,refs.length-start.refs),pullCount=Math.min(size-refCount,pulls.length-start.pulls)
  const next={generation,refs:start.refs+refCount,pulls:start.pulls+pullCount}
  return {refs:refs.slice(start.refs,next.refs),pulls:pulls.slice(start.pulls,next.pulls),next,
    done:next.refs===refs.length&&next.pulls===pulls.length}
}
