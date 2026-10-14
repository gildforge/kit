/** POST JSON to one of gild's own API routes; throws the route's `error`
 *  message when it refuses. Shared by every form that writes. */
export async function post(url: string, body: unknown, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? data.message ?? `request failed (${res.status})`)
  return data
}
