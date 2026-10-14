import { legacy } from '../../../../api/legacy.js'
export async function POST(
  request: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params,
    b = await request
      .clone()
      .json()
      .catch(() => ({}))
  return legacy(
    request,
    'addOrgMember',
    { org: name },
    {
      ...b,
      member: String(b.member ?? '')
        .toLowerCase()
        .trim()
        .replace(/^@/, ''),
    },
  )
}
