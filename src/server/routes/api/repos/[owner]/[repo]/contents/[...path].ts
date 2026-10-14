import { legacy } from '../../../../../../api/legacy.js'
/** Browser adapter only: the existing contents operation owns auth and private reads. */
export async function GET(request: Request, context: { params: Promise<{owner:string;repo:string;path:string[]}> }) {
 const {owner,repo,path}=await context.params
 return legacy(request,'contents',{owner,repo,path:path.join('/')})
}
