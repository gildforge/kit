import { csrfSafe } from '../../../../engine/csrf.js'
import { clearSession } from '../../../session.js'

export async function POST(request:Request) {
  // This route is behind settingsHTTP, which strips caller origin markers and
  // stamps the original Worker origin before OpenNext rebuilds the URL.
  if(!csrfSafe(request,{trustWorkerOrigin:true}))return Response.json({error:'Same-origin request required'},{status:403})
  const res = Response.json({ ok: true })
  await clearSession(res)
  return res
}
