import {cache} from 'react'
import {binding} from '../backend.js'
import {pageViewer} from '../page.js'
import {PreparedReadModels,PreparationPending} from '../prepared-read-models.js'
import {preparedHealth} from './prepared-health.js'
import type {Principal} from '../../engine/api/scopes.js'

const pageHealthContext=cache(async(owner:string,repo:string)=>{
  const db=await binding()
  if(!db)throw new PreparationPending()
  // pageViewer is derived from the verified session/current server ingress,
  // never from a profile body, a public API parameter or a minted token.
  const viewer=await pageViewer()
  const principal:Principal=viewer
    ? {id:'page:'+viewer.name,name:viewer.name,publicKey:'',scopes:null,repos:null}
    : {id:'page:anonymous',name:'',publicKey:'',scopes:['repo:read'],repos:null,anonymous:true}
  const models=new PreparedReadModels(db)
  const access=await models.repositoryAccess(principal,owner,repo)
  return {models,principal,access}
})

/** Complete SSR reads the same prepared policy/schema service as the API.
 * No loopback HTTP, credentials, Git, scorer, producer or preparation RPC. */
export async function pageHealth(owner:string,repo:string,commit:string){
  const {models,principal,access}=await pageHealthContext(owner,repo)
  return preparedHealth(models,principal,owner,repo,commit,access)
}
