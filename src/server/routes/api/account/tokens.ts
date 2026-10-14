import { legacy } from '../../../api/legacy.js'
export function GET(r: Request) {
  return legacy(r, 'tokens', {})
}
export function POST(r: Request) {
  return legacy(r, 'createToken', {})
}
