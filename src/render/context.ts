/** Only presentation-owned slots are substituted. Repository text, including
 * strings that look like our tokens, is opaque and must survive byte-for-byte. */
export function escapeHTML(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )
}
export function contextHTML(
  html: string,
  p: { ref: string; path: string },
  dir = '',
) {
  const values: Record<string, string> = {
    REF: encodeURIComponent(p.ref),
    PATH: encodeURIComponent(p.path),
    DIR: dir ? encodeURIComponent(dir + '/') : '',
    DOWNLOAD: escapeHTML(p.path.split('/').pop() || 'file'),
  }
  return html
    .replace(/<[a-z][^>]*\bdata-context=""[^>]*>/gi, (tag) =>
      tag
        .replace(/__GILD_(REF|PATH|DIR|DOWNLOAD)__/g, (_, key) => values[key])
        .replace(/\sdata-context=""/, ''),
    )
    .replaceAll(
      '<span data-ref-label=""></span>',
      `<span data-ref-label="">${escapeHTML(p.ref)}</span>`,
    )
}
