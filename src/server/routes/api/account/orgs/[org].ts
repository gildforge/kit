import { legacy } from '../../../../api/legacy.js'
export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  return legacy(r, 'leaveOrg', await params)
}
