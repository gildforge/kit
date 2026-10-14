/** "just now", "4 min ago", "3 h ago", "2 days ago" — for activity lists. */
export function ago(ms: number, now = Date.now(), long = false): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return long ? `${m} minute${m === 1 ? '' : 's'} ago` : `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return long ? `${h} hour${h === 1 ? '' : 's'} ago` : `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d} days ago`
  return new Date(ms).toISOString().slice(0, 10)
}

/** Repository freshness stays relative even for inactive projects. */
export function updatedAgo(ms: number, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - ms) / 86400000))
  if (days < 30) return ago(ms, now)
  const count = days < 365 ? Math.floor(days / 30) : Math.floor(days / 365)
  const unit = days < 365 ? 'month' : 'year'
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}
