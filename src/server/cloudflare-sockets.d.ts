declare module 'cloudflare:sockets' {
  export function connect(
    address: { hostname: string; port: number },
    options?: {
      secureTransport?: 'off' | 'on' | 'starttls'
      allowHalfOpen?: boolean
    },
  ): import('@cloudflare/workers-types').Socket
}
