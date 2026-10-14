import { searchAPI } from '../../search.js'
export const GET = (request: Request) => searchAPI(request)
