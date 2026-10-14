import { legacy } from '../../../api/legacy.js'
export function PUT(r: Request) {
  return legacy(r, 'updatePicture', {})
}

export function DELETE(r: Request) {
  return legacy(r, 'deletePicture', {})
}
