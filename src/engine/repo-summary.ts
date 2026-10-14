// Pure license/activity functions shared by the index summary and its tests.
export function licenseId(text: string): string | null {
  const s = text.toLowerCase().replace(/\s+/g, ' ')
  if (
    /permission is hereby granted,? free of charge/.test(s) &&
    s.includes('the software is provided "as is"')
  )
    return 'MIT'
  if (
    s.includes('apache license') &&
    /version 2\.0/.test(s) &&
    s.includes('limitations under the license')
  )
    return 'Apache-2.0'
  if (
    s.includes('mozilla public license') &&
    /(?:version|v\.?)[ ]?2\.0/.test(s)
  )
    return 'MPL-2.0'
  if (
    s.includes('gnu general public license') &&
    s.includes('version 3, 29 june 2007') &&
    !s.includes('gnu affero') &&
    !s.includes('gnu lesser')
  )
    return 'GPL-3.0'
  if (
    s.includes('permission to use, copy, modify, and/or distribute') &&
    s.includes('for any purpose with or without fee') &&
    s.includes('the software is provided "as is"')
  )
    return 'ISC'
  if (
    s.includes('redistribution and use in source and binary forms') &&
    s.includes('this software is provided') &&
    s.includes('redistributions of source code must retain') &&
    s.includes('redistributions in binary form must reproduce')
  ) {
    if (s.includes('all advertising materials')) return null
    return /neither the name|the name of .* may not be used to endorse/.test(s)
      ? 'BSD-3-Clause'
      : 'BSD-2-Clause'
  }
  return null
}
export const WEEK = 7 * 86400
// UTC Monday boundaries; stored absolute weeks can roll forward without a new tip.
export const weekOf = (seconds: number) =>
  Math.floor((seconds - 4 * 86400) / WEEK)
export function commitWeeks(dates: number[]) {
  const weeks: Record<string, number> = {}
  for (const date of dates) {
    const week = weekOf(date)
    weeks[week] = (weeks[week] ?? 0) + 1
  }
  return weeks
}
export function activityBuckets(
  weeks: Record<string, number>,
  now = Date.now(),
) {
  const last = weekOf(now / 1000)
  return Array.from({ length: 52 }, (_, i) => weeks[last - 51 + i] ?? 0)
}
export function sparklinePoints(buckets: number[]) {
  const max = Math.max(1, ...buckets)
  return buckets
    .map(
      (n, i) =>
        `${((i * 156) / Math.max(1, buckets.length - 1)).toFixed(2)},${(36 - (n / max) * 32).toFixed(2)}`,
    )
    .join(' ')
}
