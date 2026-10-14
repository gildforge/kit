import type { ImportRecord } from '../../engine/api/import-contract.js'
import { writeMeta } from '../metastore.js'
import { applyImportBatch } from '../../engine/import/apply.js'
export async function writeImportBatch(owner:string,repo:string,by:string,records:ImportRecord[]) {
  return writeMeta(owner,repo,'Import source metadata',by,fs=>applyImportBatch(fs,records),{codeRefs:{},deferProjection:true,historical:true})
}
