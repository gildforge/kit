import { legacy } from '../../api/legacy.js'
export const GET = (request: Request) => legacy(request, 'agents', {})
