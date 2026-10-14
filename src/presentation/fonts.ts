/** Both shells preload and use the same font bytes and family names. */
export function fontCSS(urls: Record<string,string>) {
  return `@font-face{font-family:'Schibsted Grotesk';font-style:normal;font-weight:100 900;font-display:block;src:url('${urls['schibsted-grotesk.woff2']}') format('woff2')}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:block;src:url('${urls['jetbrains-mono.woff2']}') format('woff2')}
:root{--font-schibsted:'Schibsted Grotesk';--font-jetbrains:'JetBrains Mono'}`
}
