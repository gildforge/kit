import type {PreparedReadModels,PreparedRepositoryAccess} from '../prepared-read-models.js'
import type {Principal} from '../../engine/api/scopes.js'
import {routes,type Output} from '../../engine/api/contract.js'
import {ApiError} from '../../engine/api/errors.js'
import type {Report} from '../../engine/cqx-report.js'

const healthRoute=routes.find(route=>route.id==='health')!
/** Shared in-process policy/read/schema service for HTTP and server rendering.
 * The producer's language breakdown is retained internally for existing SSR;
 * the HTTP DTO remains its established canonical output shape. */
export async function preparedHealth(models:PreparedReadModels,p:Principal,owner:string,repo:string,ref?:string,
  authorized?:PreparedRepositoryAccess):Promise<{report:Report|null;data:Output<'health'>;noStore:boolean}>{
  const report=await models.repositoryHealth(p,owner,repo,ref,authorized)
  const data=report?.incomplete&&report.lines===0?{...report,scores:null}:report
  const validated=healthRoute.output.safeParse(data)
  if(!validated.success)throw new ApiError(500,'Response contract violation: health')
  return {report,data:validated.data,noStore:!!report?.incomplete}
}
