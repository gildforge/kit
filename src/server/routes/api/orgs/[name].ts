import { legacy } from '../../../api/legacy.js'
import { store } from '../../../backend.js'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const st = await store()
  const org = await st.getOrg(name)
  if (!org)
    return Response.json({ error: 'org not found' }, { status: 404 })
  const members = await st.orgMembers(org.name)
  return Response.json({ org, members })
}

export async function DELETE(r:Request,{params}:{params:Promise<{name:string}>}){return legacy(r,'deleteOrg',{org:(await params).name})}
