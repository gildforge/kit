import { parseDocument } from 'yaml'
import { parseWorkflow } from '../actions/workflow.js'
import { actionSupport,workflowKeys,jobKeys,stepKeys,eventKeys } from '../actions/support.js'
/** The parser and the runner's shared support contract own these boundaries. */
export function workflowWarnings(file:string,text:string) {
  const warnings=new Set<string>(),parsed=parseWorkflow(file,text)
  if(parsed.error)warnings.add(`${file}: ${parsed.error}`)
  let document:Record<string,any>
  try {document=parseDocument(text,{version:'1.2',uniqueKeys:true}).toJS({maxAliasCount:50});if(!document || typeof document!=='object')return [...warnings]}catch{return [...warnings]}
  const keys=(object:any,allowed:string[],path:string)=>{if(!object || typeof object!=='object')return;for(const key of Object.keys(object))if(!allowed.includes(key))warnings.add(`${file}: gild doesn't support ${path}.${key} yet`)}
  keys(document,workflowKeys,'workflow')
  if(typeof document.on==='string')keys({[document.on]:true},eventKeys,'on')
  else if(Array.isArray(document.on))keys(Object.fromEntries(document.on.map((event:string)=>[event,true])),eventKeys,'on')
  else {keys(document.on,eventKeys,'on');for(const [event,filters] of Object.entries(document.on??{})) keys(filters,event==='workflow_dispatch'?[]:event==='push'?['branches','branches-ignore','tags','tags-ignore','paths','paths-ignore']:['branches','branches-ignore','paths','paths-ignore','types'],`on.${event}`)}
  for(const [id,job] of Object.entries(document.jobs??{}) as [string,any][]) {
    keys(job,jobKeys,`jobs.${id}`);keys(job?.strategy,['matrix','fail-fast'],`jobs.${id}.strategy`)
    if(job?.strategy?.['fail-fast']===true)warnings.add(`${file}: explicit strategy.fail-fast: true is unsupported`)
    for(const [i,step] of (Array.isArray(job?.steps)?job.steps:[]).entries()) {
      keys(step,stepKeys,`jobs.${id}.steps.${i}`)
      if(typeof step?.uses==='string') {const support=actionSupport(step.uses,step.with??{});if(support.error)warnings.add(`${file}: ${support.error}`);for(const warning of support.warnings)warnings.add(`${file}: ${warning}`)}
    }
  }
  if(text.includes('secrets.GITHUB_TOKEN'))warnings.add(`${file}: gild does not synthesize a GitHub API token`)
  return [...warnings]
}
