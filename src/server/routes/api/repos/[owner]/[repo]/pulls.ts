import { legacy } from '../../../../../api/legacy.js'
type Ctx={params:Promise<{owner:string;repo:string}>}
export async function GET(request:Request,ctx:Ctx) {return legacy(request,'pulls',await ctx.params)}
export async function POST(request:Request,ctx:Ctx) {return legacy(request,'createPull',await ctx.params)}
