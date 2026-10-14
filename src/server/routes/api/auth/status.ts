import { browserStatus } from '../../../browser-status.js'
export function GET(request: Request) { return browserStatus(request, 'auth') }
