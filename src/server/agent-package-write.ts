import type {Context,Result} from './api/dispatch.js'
import {ApiError} from '../engine/api/errors.js'
import {parseAgentPackageManifest} from '../engine/api/agent-package-contract.js'
import {readyIndex} from './repo-index.js'
import {pushPackageManifest} from './gitproxy.js'
import {editTree,encodeCommit,buildPack,hashObject} from '../engine/git-pack.js'

/** A report-status HTTP200 is successful only when unpack AND the exact CAS ref succeeded. */
export function packagePushAccepted(bytes:string,ref:string) {
 const data=new TextEncoder().encode(bytes),decoder=new TextDecoder(),parts:string[]=[];let at=0
 while(at<data.length){const prefix=decoder.decode(data.subarray(at,at+4));if(!/^[0-9a-f]{4}$/i.test(prefix))return false;const size=parseInt(prefix,16);if(size===0){at+=4;continue}if(size<4||at+size>data.length)return false;parts.push(decoder.decode(data.subarray(at+4,at+size)));at+=size}
 return parts.includes('unpack ok\n')&&parts.includes(`ok ${ref}\n`)
}
/** Called only by the registered operation after shared identity, private read and writer checks. */
export async function writePackageManifest(c:Context):Promise<Result> {
 if(c.route.id!=='updateAgentPackage'||c.principal.anonymous||c.principal.name.includes('/'))throw new ApiError(403,'Repository writer required')
 const {owner,repo}=c.params,{text,branch,expected_head}=c.body as {text:string;branch:string;expected_head:string}
 if(new TextEncoder().encode(text).length>128*1024)throw new ApiError(413,'Manifest exceeds128KiB')
 try{parseAgentPackageManifest(text)}catch{throw new ApiError(422,'Invalid gild.json; validate the package before saving')}
 const index=await readyIndex(owner,repo);if(!index)throw new ApiError(503,'Pending · repository index is not ready')
 const base=await index.commit(expected_head);if(!base)throw new ApiError(409,'The loaded commit is unavailable; reload before saving')
 const entries=await index.tree(base.tree);if(!entries)throw new ApiError(503,'Pending · immutable tree is not ready')
 const file=entries.find(e=>e.name==='gild.json')
 if(!file||file.type!=='blob'||!['100644','100755'].includes(file.mode))throw new ApiError(422,'gild.json must already be a regular file')
 const changed=await editTree(async sha=>{if(sha!==base.tree)throw new ApiError(503,'Pending · immutable tree is not ready');return entries.map(e=>({name:e.name,type:e.type,mode:e.mode,sha:e.child}))},base.tree,[{path:'gild.json',content:text}])
 const commit=await encodeCommit({tree:changed.root,parents:[expected_head],author:{name:c.principal.name,email:`${c.principal.name}@users.gild.gg`,seconds:Math.floor(Date.now()/1000)},message:'Update gild.json package profiles'})
 const pack=await buildPack([...changed.objects,commit]),ref=`refs/heads/${branch}`,command=`${expected_head} ${commit.oid} ${ref}\0report-status\n`
 const prefix=new TextEncoder().encode((new TextEncoder().encode(command).length+4).toString(16).padStart(4,'0')+command+'0000'),body=new Uint8Array(prefix.length+pack.length);body.set(prefix);body.set(pack,prefix.length)
 const url=new URL(c.request.url);url.pathname=`/${owner}/${repo}.git/git-receive-pack`;url.search=''
 const response=await pushPackageManifest(new Request(url,{method:'POST',headers:{'content-type':'application/x-git-receive-pack-request','accept':'application/x-git-receive-pack-result'},body}),{owner,repo:repo+'.git',path:['git-receive-pack']},c.principal)
 if(!response.ok)throw new ApiError(response.status,'Repository refused the package save')
 if(!packagePushAccepted(await response.text(),ref))throw new ApiError(409,'Git did not confirm the save; reload to check the branch before retrying')
 const blob=await hashObject('blob',new TextEncoder().encode(text))
 return {data:{branch,commit:commit.oid,blob:blob.oid},noStore:true}
}
