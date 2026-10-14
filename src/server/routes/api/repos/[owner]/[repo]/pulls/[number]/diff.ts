import { legacy } from '../../../../../../../api/legacy.js'
export async function GET(request:Request,ctx:{params:Promise<{owner:string;repo:string;number:string}>}) {return legacy(request,'pullChanges',await ctx.params)}
