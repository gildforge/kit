export class ApiError extends Error {
  readonly code?: string
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export function errorResponse(
  status: number,
  message: string,
  errors?: { message: string; field?: string; code?: string }[],
) {
  return Response.json(
    { message, documentation_url: '/docs/api', ...(errors ? { errors } : {}) },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        ...(status === 503 ? { 'retry-after': '1' } : {}),
      },
    },
  )
}
export function requireFound<T>(
  value: T | null | undefined,
  message = 'Not Found',
): T {
  if (value == null) throw new ApiError(404, message)
  return value
}
