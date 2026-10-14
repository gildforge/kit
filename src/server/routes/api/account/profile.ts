import { legacy } from '../../../api/legacy.js'
export function GET(r: Request) {
  return legacy(r, 'profile', {})
}
export function PATCH(r: Request) {
  return legacy(r, 'updateProfile', {})
}
