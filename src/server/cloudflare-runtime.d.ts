// The runtime import is provided by workerd, not npm. Keep these base-class
// types module-scoped so Worker Request/Response globals don't override the
// DOM types used by Next and its client components.
declare module 'cloudflare:workers' {
  class DurableObject<Env> {
    protected ctx: import('@cloudflare/workers-types').DurableObjectState
    protected env: Env
    constructor(ctx: import('@cloudflare/workers-types').DurableObjectState, env: Env)
  }
  class RpcTarget {}
  class WorkerEntrypoint {
    protected ctx: import('@cloudflare/workers-types').ExecutionContext
  }
  /** The Worker's bindings, readable from any isolate (workerd and celld). */
  const env: Record<string, unknown>
  export { DurableObject, RpcTarget, WorkerEntrypoint, env }
}
