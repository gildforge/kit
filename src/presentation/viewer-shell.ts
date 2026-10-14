/** Personalize cached strings at the request/navigation boundary, never in R2. */
export function viewerShell(html: string, url: URL, signedIn: boolean) {
  if (signedIn) html = html.replace('<html lang="en"', '<html data-portal="true" lang="en"')
  const href = '/auth/device?next=' + encodeURIComponent(url.pathname + url.search + url.hash)
  return html.replace(/<a\b[^>]*\bdata-return-to=""[^>]*>/g, tag => tag.replace(/\bhref="[^"]*"/, `href="${href}"`))
}
