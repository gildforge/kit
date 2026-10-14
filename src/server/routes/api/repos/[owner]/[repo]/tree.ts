import { legacy } from '../../../../../api/legacy.js'
export async function GET(request:Request,ctx:{params:Promise<{owner:string;repo:string}>}) {
 const sha=new URL(request.url).searchParams.get('hash') ?? '';if(!/^[0-9a-f]{40}$/.test(sha))return Response.json({error:'hash must be a 40-character tree id'},{status:400});return legacy(request,'tree',{...await ctx.params,sha})
}
