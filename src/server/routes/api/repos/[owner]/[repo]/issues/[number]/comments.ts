import { legacy } from '../../../../../../../api/legacy.js'
type Ctx={params:Promise<{owner:string;repo:string;number:string}>}
export async function GET(request:Request,ctx:Ctx) {return legacy(request,'issueComments',await ctx.params)}
export async function POST(request:Request,ctx:Ctx) {return legacy(request,'createIssueComment',await ctx.params)}
