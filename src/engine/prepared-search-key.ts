import type {Document} from './search-query.js'

export interface SearchSnapshot {id:string;epoch:number;meta:string|null;ref:string;tip:string}
export interface SearchDocument {
  path:string;blob:string;language:string;content:string;symbols:Document['symbols']
}
export const SEARCH_INDEX_VERSION='search:v1'
const SHA=/^[a-f0-9]{40}$/
export function searchSnapshotKey(snapshot:SearchSnapshot){
  if(typeof snapshot.id!=='string'||!snapshot.id||!Number.isSafeInteger(snapshot.epoch)||snapshot.epoch<0
    ||snapshot.meta!==null&&typeof snapshot.meta!=='string'||typeof snapshot.ref!=='string'||!snapshot.ref||snapshot.ref.length>1024||snapshot.ref.includes('\0')||!SHA.test(snapshot.tip))
    throw new Error('Invalid search snapshot')
  return JSON.stringify([SEARCH_INDEX_VERSION,snapshot.id,snapshot.epoch,snapshot.meta,snapshot.ref,snapshot.tip])
}
