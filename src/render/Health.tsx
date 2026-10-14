// cqx code health: the five original categories, each starting at 100 and
// losing points only to a named rule. Bands follow cqx-kit's Score: 90 and up
// passes, 50 and up warns, below that fails.
import { FragmentLink as Link } from './link.tsx'
import {
  scoreNote,
  CATEGORIES,
  type Category,
  type Report,
} from '../engine/cqx-report.ts'
import h from './styles/health.module.css'
import { LANGUAGES } from '../engine/cqx-reads.ts'

const languageName = (id: string) =>
  (({ cpp: 'C++', csharp: 'C#' }) as Record<string, string>)[id] ??
  LANGUAGES.find((l) => l.name.toLowerCase() === id)?.name ??
  id

const TITLE: Record<Category, string> = {
  quality: 'Quality',
  containment: 'Containment',
  legibility: 'Legibility',
  security: 'Security',
  modularity: 'Modularity',
}
const tone = (n: number) =>
  n >= 90 ? 'var(--ok)' : n >= 50 ? 'var(--accent)' : 'var(--bad)'
const CIRC = 2 * Math.PI * 26

/** The compact version under Languages: five thin bars, the title links to the report. */
export function HealthBars({
  report,
  href,
  note,
}: {
  report: Report | null
  href: string
  note: string
}) {
  return (
    <>
      <h2>
        <Link href={href} className={h.titleLink}>
          Code Score
        </Link>
      </h2>
      {report && report.lines > 0 ? (
        <div className={h.bars}>
          {CATEGORIES.map((c) => (
            <span
              key={c}
              className={h.bar}
              title={`${TITLE[c]}: ${report.scores[c]}`}
            >
              <span
                style={{
                  width: `${report.scores[c]}%`,
                  background: tone(report.scores[c]),
                }}
              />
            </span>
          ))}
        </div>
      ) : null}
      <span className={h.note}>{scoreNote(report) ?? note}</span>
    </>
  )
}

/** Dials, the rules behind the picked category, and what it was calibrated with. */
export function HealthReview({
  report,
  before,
  beforeName,
  picked,
  pickHref,
  title,
  lede,
  allCategories = false,
}: {
  report: Report
  before?: Report | null
  beforeName?: string
  picked: Category | null
  pickHref: (c: Category) => string
  title: import('react').ReactNode
  lede?: string
  allCategories?: boolean
}) {
  const incompleteNote = scoreNote(report)
  const beforeNote = scoreNote(before ?? null)
  if (report.lines === 0)
    return (
      <section className={h.review} id="score">
        <h2>{title}</h2>
        <p>{incompleteNote}</p>
      </section>
    )
  // Compare only complete analyses; changes in coverage are not score deltas.
  const comparison =
    !report.incomplete && !before?.incomplete && before?.lines ? before : null
  // Open on the category that lost the most, so the first look is the useful one.
  const cat =
    picked ??
    [...CATEGORIES].sort((a, b) => report.scores[a] - report.scores[b])[0]
  const hits = report.rules
    .filter((r) => r.category === cat && r.deducted > 0)
    .sort((a, b) => b.deducted - a.deducted)
  const languages = Object.entries(report.languages ?? {}).sort(
    ([, a], [, b]) => b.lines - a.lines,
  )
  return (
    <section
      className={h.review}
      id="score"
      data-score-default={allCategories ? cat : undefined}
    >
      <div className={h.head}>
        <h2>{title}</h2>
        {lede && <p>{lede}</p>}
        {incompleteNote && <p role="status">{incompleteNote}</p>}
        {beforeNote && (
          <p role="status">
            {beforeName}: {beforeNote} Score comparison unavailable.
          </p>
        )}
        {languages.length > 1 && (
          <p>Headline scores are weighted by each language’s product lines.</p>
        )}
      </div>
      <div className={h.dials}>
        {CATEGORIES.map((c) => {
          const n = report.scores[c]
          const d = comparison ? n - comparison.scores[c] : 0
          return (
            <Link
              key={c}
              href={pickHref(c)}
              data-context={allCategories ? '' : undefined}
              scroll={false}
              className={`${h.dial} ${c === cat ? h.on : ''}`}
              data-score-category={allCategories ? c : undefined}
              data-on-class={allCategories ? h.on : undefined}
              aria-current={c === cat}
            >
              <svg viewBox="0 0 62 62" width="62" height="62" aria-hidden>
                <circle
                  cx="31"
                  cy="31"
                  r="26"
                  fill="none"
                  stroke={tone(n)}
                  strokeWidth="4"
                  opacity="0.25"
                />
                <circle
                  cx="31"
                  cy="31"
                  r="26"
                  fill="none"
                  stroke={tone(n)}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC * (1 - n / 100)}
                  transform="rotate(-90 31 31)"
                />
                <text
                  x="31"
                  y="31"
                  fill={tone(n)}
                  className={h.num}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {n}
                </text>
              </svg>
              <span className={h.dialTitle}>{TITLE[c]}</span>
              <span
                className={h.delta}
                style={{
                  color:
                    d > 0
                      ? 'var(--ok)'
                      : d < 0
                        ? 'var(--bad)'
                        : 'var(--ink-faint)',
                }}
              >
                {comparison
                  ? d === 0
                    ? `same as ${beforeName}`
                    : `${d > 0 ? '+' : '−'}${Math.abs(d)} vs ${beforeName}`
                  : ''}
              </span>
              {languages.length > 1 && (
                <span className={h.languageScores}>
                  {languages.map(([id, language]) => (
                    <span key={id} className={h.languageScore}>
                      <span>{languageName(id)}</span>
                      <b style={{ color: tone(language.scores[c]) }}>
                        {language.scores[c]}
                      </b>
                    </span>
                  ))}
                </span>
              )}
            </Link>
          )
        })}
      </div>
      {languages.length > 1 && (
        <p className={h.languageLines} aria-label="Per-language product lines">
          {languages.map(([id, language]) => (
            <span key={id}>
              {languageName(id)} · {language.lines.toLocaleString()} product
              lines
            </span>
          ))}
        </p>
      )}

      {(allCategories ? CATEGORIES : [cat]).map((category) => {
        const findings =
          category === cat
            ? hits
            : report.rules
                .filter((r) => r.category === category && r.deducted > 0)
                .sort((a, b) => b.deducted - a.deducted)
        return (
          <div
            className={h.panels}
            data-category={allCategories ? category : undefined}
            hidden={allCategories && category !== cat}
            key={category}
          >
            <div className={h.findings}>
              <div className={h.panelHead}>
                {TITLE[category]}: {report.scores[category]}
              </div>
              {findings.length === 0 ? (
                <p className={h.empty}>
                  No {TITLE[category].toLowerCase()} rule took points here.
                </p>
              ) : (
                findings.map((r) => (
                  <div key={`${r.language}/${r.rule}`} className={h.rule}>
                    <div className={h.ruleHead}>
                      <span className={h.ruleId}>
                        [{r.language ? `${r.language}/` : ''}
                        {r.rule}]
                      </span>
                      <span className={h.taken}>
                        −{+r.deducted.toFixed(1)} · {r.total_findings}{' '}
                        {r.total_findings === 1 ? 'finding' : 'findings'}
                      </span>
                    </div>
                    <p className={h.describes}>{r.describes}</p>
                    {r.findings.slice(0, 3).map((f, i) => (
                      <div key={i} className={h.finding}>
                        <span className={h.where}>
                          {f.file}:{f.line}
                        </span>
                        {f.text ? (
                          <pre className={h.code}>{f.text}</pre>
                        ) : (
                          <span className={h.what}>{f.what}</span>
                        )}
                      </div>
                    ))}
                    <p className={h.remedy}>{r.remedy}</p>
                  </div>
                ))
              )}
            </div>
            <aside className={h.calibration}>
              <div className={h.panelHead}>Calibration</div>
              <p>
                {report.calibrated
                  ? 'Scored against the cqx.json at the repo root. Rules it doesn’t mention keep cqx’s defaults.'
                  : 'cqx defaults: this repo has no cqx.json at its root. Add one to change a rule’s standard or exclude paths.'}
              </p>
              <p className={h.note}>
                {report.lines.toLocaleString()} lines analysed.
              </p>
            </aside>
          </div>
        )
      })}
    </section>
  )
}

export const isCategory = (c: string | undefined): c is Category =>
  !!c && (CATEGORIES as readonly string[]).includes(c)
