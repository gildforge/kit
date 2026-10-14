/** Why a C-family scan was left out of a score. */
export type CFamilyIssue = 'c-family-unavailable' | 'c-family-too-large'
export const CATEGORIES = [
  'quality',
  'containment',
  'legibility',
  'security',
  'modularity',
] as const
export type Category = (typeof CATEGORIES)[number]

export interface Finding {
  what: string
  file: string
  line: number
  text?: string
}
export interface RuleHit {
  rule: string
  category: Category
  language: string
  describes: string
  remedy: string
  deducted: number
  total_findings: number
  findings: Finding[]
}
export interface Report {
  /** Incomplete scans are never cached; numbers describe only scored languages. */
  incomplete?: CFamilyIssue | 'unavailable'
  lines: number
  scores: Record<Category, number>
  rules: RuleHit[]
  /** cqx preserves single-language JSON; this block is present for mixed repos. */
  languages?: Record<string, LanguageReport>
  /** Whether a cqx.json at the repo root calibrated this score. */
  calibrated: boolean
}

export interface LanguageReport {
  lines: number
  scores: Record<Category, number>
  rules: RuleHit[]
}

export function scoreNote(report: Report | null): string | null {
  if (!report?.incomplete) return null
  const note =
    report.incomplete === 'c-family-too-large'
      ? 'This repository is too large to score C-family here.'
      : report.incomplete === 'c-family-unavailable'
        ? 'C/C++/C# couldn’t be scored right now.'
        : 'Code couldn’t be scored right now.'
  return (
    note + (report.lines > 0 ? ' Partial score: other languages only.' : '')
  )
}

/** An analysis failure has no score, rather than claiming zero or perfection. */
export function scoreUnavailable(): Report {
  return {
    lines: 0,
    scores: {
      quality: 0,
      containment: 0,
      legibility: 0,
      security: 0,
      modularity: 0,
    },
    rules: [],
    calibrated: false,
    incomplete: 'unavailable',
  }
}
