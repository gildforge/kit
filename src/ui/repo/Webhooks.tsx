'use client'
import { useEffect, useState } from 'react'
import {
  EVENT_NAMES,
  type Hook,
  type Delivery,
} from '../../engine/api/events-contract.js'
import s from './webhooks.module.css'
export function Webhooks({
  owner,
  repo,
  org = false,
  disabled = false,
}: {
  owner: string
  repo?: string
  org?: boolean
  disabled?: boolean
}) {
  const base = org
      ? `/api/orgs/${owner}/hooks`
      : `/api/repos/${owner}/${repo}/hooks`,
    [hooks, setHooks] = useState<Hook[]>([]),
    [deliveries, setDeliveries] = useState<Record<number, Delivery[]>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function api(path = '', method = 'GET', body?: unknown) {
    const r = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      data = await r.json()
    if (!r.ok) throw Error(data.message ?? data.error)
    return data
  }
  async function refresh() {
    setHooks(await api())
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message))
  }, [base]) // mutable settings are private, uncached reads
  async function perform(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={s.root}>
      <h1>Webhooks</h1>
      {error && <p role="alert">{error}</p>}
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault()
          const form = e.currentTarget,
            data = new FormData(form)
          void perform(async () => {
            await api('', 'POST', {
              config: {
                url: data.get('url'),
                secret: data.get('secret'),
                content_type: 'json',
              },
              events: data.getAll('events'),
            })
            form.reset()
            await refresh()
          })
        }}
      >
        <fieldset
          disabled={disabled || busy}
          style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}
        >
          <label>
            Payload URL
            <input
              name="url"
              type="url"
              placeholder="https://example.com/events"
              required
            />
          </label>
          <label>
            Secret
            <input
              name="secret"
              type="password"
              autoComplete="new-password"
              minLength={1}
              maxLength={256}
              required
            />
          </label>
          <fieldset>
            <legend>Events</legend>
            <div className={s.events}>
              {EVENT_NAMES.filter(
                (n) => n !== 'webhook_disabled' && n !== 'ping',
              ).map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    name="events"
                    value={name}
                    defaultChecked={name === 'push'}
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <button disabled={disabled || busy}>Create webhook</button>
        </fieldset>
      </form>
      {hooks.map((h) => (
        <article key={h.id} className={s.hook}>
          <h3>{h.config.url}</h3>
          <p>
            {h.active ? 'Active' : 'Inactive'} · {h.events.join(', ')}
          </p>
          {h.disabled_reason && <p role="status">{h.disabled_reason}</p>}
          <div className={s.buttons}>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await api('/' + h.id, 'PATCH', { active: !h.active })
                  await refresh()
                })
              }
            >
              {h.active ? 'Disable' : 'Enable'}
            </button>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await api('/' + h.id + '/pings', 'POST', {})
                  setDeliveries((d) => ({ ...d, [h.id]: [] }))
                })
              }
            >
              Send ping
            </button>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  const rows = await api('/' + h.id + '/deliveries')
                  setDeliveries((d) => ({ ...d, [h.id]: rows }))
                })
              }
            >
              Recent deliveries
            </button>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await api('/' + h.id, 'DELETE')
                  await refresh()
                })
              }
            >
              Delete
            </button>
          </div>
          {deliveries[h.id]?.map((d) => (
            <details key={d.id}>
              <summary>
                {d.event} · {d.status} · {d.status_code ?? 'no response'} ·{' '}
                {d.attempts} attempts
              </summary>
              <p>
                {d.delivered_at ?? 'Pending'} · {d.duration.toFixed(3)}s
              </p>
              {d.error && <p>{d.error}</p>}
              <h4>Request headers</h4>
              <pre>{JSON.stringify(d.request.headers, null, 2)}</pre>
              <h4>Request body</h4>
              <pre>{d.request.wire}</pre>
              <h4>Response</h4>
              <pre>
                {d.response.payload}
                {d.response.truncated ? '\n[truncated]' : ''}
              </pre>
              <button
                disabled={disabled || busy}
                onClick={() =>
                  void perform(async () => {
                    await api(
                      `/${h.id}/deliveries/${d.id}/attempts`,
                      'POST',
                      {},
                    )
                    const rows = await api('/' + h.id + '/deliveries')
                    setDeliveries((v) => ({ ...v, [h.id]: rows }))
                  })
                }
              >
                Redeliver
              </button>
            </details>
          ))}
        </article>
      ))}
    </section>
  )
}
