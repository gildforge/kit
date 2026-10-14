import { legacy } from '../../../../../api/legacy.js'
async function handle(
  r: Request,
  params: Promise<{ name: string; member: string }>,
) {
  const p = await params
  return legacy(r, r.method === 'PUT' ? 'putMembership' : 'deleteMembership', {
    org: p.name,
    name: p.member,
  })
}
export function PUT(
  r: Request,
  { params }: { params: Promise<{ name: string; member: string }> },
) {
  return handle(r, params)
}
export const DELETE = PUT
