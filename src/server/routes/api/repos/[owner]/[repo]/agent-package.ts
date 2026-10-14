import {legacy} from '../../../../../api/legacy.js'
/** Shared browser session/CSRF, registered validation and repository ACLs precede the fixed-file writer. */
export async function PUT(request:Request,context:{params:Promise<{owner:string;repo:string}>}) {
 return legacy(request,'updateAgentPackage',await context.params)
}
