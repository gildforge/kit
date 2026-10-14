import { legacy } from '../../../../api/legacy.js'
export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return legacy(r, 'deleteToken', await params)
}
