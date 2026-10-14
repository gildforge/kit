import { legacy } from '../../api/legacy.js'
export const GET = (request: Request) => legacy(request, 'orgs', {})
export async function POST(request: Request) {
  const b = await request
    .clone()
    .json()
    .catch(() => ({}))
  return legacy(
    request,
    'createOrg',
    {},
    {
      ...b,
      name: String(b.name ?? '')
        .toLowerCase()
        .trim()
        .replace(/^@/, ''),
    },
  )
}
