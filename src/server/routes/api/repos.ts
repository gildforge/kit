import { session } from '../../session.js'
import { repoList } from '../../repo-list.js'
import { store } from '../../backend.js'
import { whoIsCalling } from '../../caller.js'

const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i

export async function GET() {
  const s = await session()
  if (!s?.name)
    return Response.json({ error: 'not signed in' }, { status: 401 })
  const st = await store()
  const orgs = await st.orgsFor(s.name)
  return Response.json(
    {
      me: s.name,
      repos: await repoList(s.name, s.name),
      orgs: await Promise.all(
        orgs.map(async (o) => ({
          ...o,
          repos: await repoList(o.name, s.name ?? null),
        })),
      ),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}

export async function POST(request: Request) {
  const proof = request.clone()
  const caller = await whoIsCalling(proof)
  if (!caller) {
    return Response.json(
      { error: 'not signed in — claim a name first' },
      { status: 401 },
    )
  }
  const body = (caller.body ?? (await request.json())) as {
    name?: string
    description?: string
    owner?: string
    private?: boolean
  }
  const name = (body.name ?? '').trim()
  const owner =
    (body.owner ?? '').toLowerCase().trim().replace(/^@/, '') || caller.name

  if (!REPO_RE.test(name)) {
    return Response.json(
      {
        error:
          'repo names start with a letter or digit; letters, digits, . _ - after that',
      },
      { status: 400 },
    )
  }

  const { legacy } = await import('@gildforge/kit/server/api/legacy')
  // Rebuild after parsing: OpenNext's consumed request stream cannot be cloned
  // by the shared adapter. Preserve the original proof fields for signed callers.
  const adapted = new Request(proof.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  })
  return legacy(
    adapted,
    owner === caller.name ? 'createRepository' : 'createOrgRepository',
    owner === caller.name ? {} : { org: owner },
    { name, description: body.description, private: body.private ?? false },
  )
}
