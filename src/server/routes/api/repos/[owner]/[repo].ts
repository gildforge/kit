import { legacy } from '../../../../api/legacy.js'
export async function PATCH(
  r: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  return legacy(r, 'updateRepository', await params)
}
export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  return legacy(r, 'deleteRepo', await params)
}
