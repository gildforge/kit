import { legacy } from '../../../../../../../api/legacy.js'
type Ctx={params:Promise<{owner:string;repo:string;number:string}>}
export async function POST(request:Request,ctx:Ctx) {const body=await request.json().catch(()=>({}));return legacy(request,'createReview',await ctx.params,{body:body.body ?? '',event:body.verdict==='approve' ? 'APPROVE' : body.verdict==='changes' ? 'REQUEST_CHANGES' : 'COMMENT'})}
