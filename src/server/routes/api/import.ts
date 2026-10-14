import { whoIsCalling } from '../../caller.js'
import { legacy } from '../../api/legacy.js'
export async function POST(request:Request) {
  const caller=await whoIsCalling(request.clone())
  if(!caller) return Response.json({error:'Sign in to import a repository'},{status:401})
  const body=caller.body??await request.clone().json(),owner=body.owner??caller.name
  return legacy(request,owner===caller.name?'importCreate':'importOrgCreate',owner===caller.name?{}:{org:owner},body)
}
