import type { Receipt } from '../engine/sessions-contract.js'
import s from './styles/receipts.module.css'
export function SessionReceipts({
  receipts,
  fileHref,
}: {
  receipts: Receipt[]
  fileHref: (path: string) => string
}) {
  if (!receipts.length) return null
  return (
    <section className={s.receipts} aria-label="Agent session receipts">
      <h2>How this was made</h2>
      {receipts.map((r) => (
        <details key={r.id} className={s.receipt}>
          <summary>
            <strong>@{r.agent}</strong> · Reported model: {r.model} ·{' '}
            {r.closed ? 'Reported complete' : 'Reported in progress'}
          </summary>
          <div className={s.body}>
            <p>
              Reported times:{' '}
              <time dateTime={r.started_at}>{r.started_at}</time> →{' '}
              {r.ended_at ? (
                <time dateTime={r.ended_at}>{r.ended_at}</time>
              ) : (
                'in progress'
              )}
            </p>
            <p>
              Reported usage: {r.tokens_in.toLocaleString()} tokens in ·{' '}
              {r.tokens_out.toLocaleString()} tokens out
              {r.cost !== undefined
                ? ` · Reported cost: ${r.currency} ${r.cost.toFixed(4)}`
                : ''}
            </p>
            <h3>Agent-reported commands</h3>
            <ol>
              {r.commands.map((c, i) => (
                <li key={i}>
                  {c.name.length > 160 || c.name.includes('\n') ? (
                    <details>
                      <summary>
                        Reported command: {c.name.slice(0, 120)}…
                      </summary>
                      <code>{c.name}</code>
                    </details>
                  ) : (
                    <code>{c.name}</code>
                  )}
                  <span>
                    Reported exit {c.exit_code ?? 'pending'} ·{' '}
                    {(c.duration_ms / 1000).toFixed(3)}s
                  </span>
                </li>
              ))}
            </ol>
            <div className={s.files}>
              {(['read', 'written'] as const).map((kind) => (
                <section key={kind}>
                  <h3>Reported files {kind}</h3>
                  <ul>
                    {r.files[kind].map((path) => (
                      <li key={path}>
                        <a href={fileHref(path)}>{path}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {r.notes && <p className={s.notes}>Reported notes: {r.notes}</p>}
            <p>
              Stored revision {r.version} ·{' '}
              {r.closed
                ? 'Agent reported completion'
                : 'Agent reported work in progress'}
            </p>
          </div>
        </details>
      ))}
    </section>
  )
}
