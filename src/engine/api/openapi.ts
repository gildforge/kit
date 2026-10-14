import { publicRead } from './routing.js'
import { z } from 'zod'
import { routes, errorSchema } from './contract.js'
import { ORCHESTRATED_OPERATIONS } from './orchestrator-contract.js'
let cached: ReturnType<typeof build> | undefined
export function openapi() {
  return (cached ??= build())
}
function build() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of routes) {
    const pathSchema = z.toJSONSchema(r.params) as {
      properties: Record<string, unknown>
    }
    const parameters: unknown[] = Object.entries(pathSchema.properties).map(
      ([name, schema]) => ({ name, in: 'path', required: true, schema }),
    )
    const query = z.toJSONSchema(r.query) as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    for (const [name, schema] of Object.entries(query.properties ?? {}))
      parameters.push({
        name,
        in: 'query',
        required: query.required?.includes(name) ?? false,
        schema,
      })
    const responses: Record<string, unknown> = {
      [r.status]: {
        description: 'Success',
        ...(r.status === 204 || r.status===101 ? {} : { content: { 'application/json': { schema: z.toJSONSchema(r.output) } } }),
      },
    }
    for (const status of [400, 401, 403, 404, 409, 422, 426, 429, 503])
      responses[status] = {
        description: 'Error',
        content: {
          'application/json': { schema: z.toJSONSchema(errorSchema) },
        },
      }
    const operation = {
      operationId: r.id,
      parameters,
      security: r.scope || r.id==='channelPost' || (ORCHESTRATED_OPERATIONS as readonly string[]).includes(r.id) ? (publicRead(r) ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }]) : [],
      'x-gild-phase':r.phase,
      'x-gild-scope': r.scope,
      'x-gild-cache': r.cache,
      'x-github-compatible': r.github,
      responses,
      ...(r.method !== 'GET' && r.method !== 'DELETE'
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: z.toJSONSchema(r.input) },
              },
            },
          }
        : {}),
    }
    ;(paths[r.path] ??= {})[r.method.toLowerCase()] = operation
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'gild API',
      version: '1.0.0',
      description:
        'Neutral forge API. Merge requests enqueue; gild never runs agents.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'gf_' },
      },
    },
  }
}
