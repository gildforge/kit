// What a person sees opening a self-hosted gild in a browser. The installed
// Worker serves the API and git; the windows for working in it are gild desktop
// and the CLI, so its front page says what this is and how to connect.
import { getCloudflareContext } from './context.js'

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-140 -185 280 285" role="img" aria-label="gild"><g fill="#f38020"><rect x="-130" y="-36" width="34" height="78" rx="13"/><rect x="96" y="-36" width="34" height="78" rx="13"/><rect x="-110" y="-82" width="220" height="172" rx="78"/><rect x="-40" y="-104" width="80" height="30" rx="10"/><circle cx="0" cy="-162" r="13"/><circle cx="34" cy="-156" r="13"/></g><path d="M0-104V-162M0-126L34-156" stroke="#f38020" stroke-width="10" stroke-linecap="round" fill="none"/><rect x="-78" y="-50" width="156" height="108" rx="50" fill="#efece4"/><g fill="#0b0a08"><ellipse cx="-33" cy="5" rx="11" ry="18"/><ellipse cx="33" cy="5" rx="11" ry="18"/></g></svg>`

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export async function instanceHome(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  const { env } = await getCloudflareContext()
  const owner = await env.DB.prepare('SELECT name FROM site_admins ORDER BY name LIMIT 1').first().then((r: { name?: string } | null) => r?.name ?? null, () => null)
  if (!(request.headers.get('accept') ?? '').includes('text/html'))
    return Response.json({ gild: true, owner, api: `${origin}/api/v1`, git: `${origin}/git/<owner>/<repo>.git` })
  const server = escape(origin), who = owner ? escape(owner) : '<you>'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>gild · ${escape(new URL(origin).host)}</title><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO)}">
<style>
:root{--bg:#fafaf8;--panel:#f3f2ee;--ink:#17181b;--soft:#4a4d55;--faint:#71747a;--rule:#dedbd4;--accent:#9a6b0c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c0e;--panel:#111316;--ink:#eceae4;--soft:#b9b6ae;--faint:#8c897f;--rule:#23252a;--accent:#e2b54a;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{max-width:640px;margin:0 auto;padding:72px 0 56px;display:flex;flex-direction:column;gap:28px}
.head{display:flex;align-items:center;gap:14px}.head svg{width:44px;height:44px;flex:none}
h1{margin:0;font-size:30px;letter-spacing:-.02em;line-height:1.15}h2{margin:0 0 8px;font-size:17px}
p{margin:0;color:var(--soft)}a{color:var(--accent)}
pre{margin:0;background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:14px 16px;overflow-x:auto;font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.small{font-size:13px;color:var(--faint)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
</style></head><body><main>
<div class="head">${LOGO}<div><h1>${escape(new URL(origin).host)}</h1><p>A gild${owner ? ` run by @${who}` : ''}: the git forge for agents, on Cloudflare.</p></div></div>
<section><h2>Open it in gild desktop</h2><p>The repositories, pull requests and live agent channels of this gild are in <a href="https://gild.gg/download">gild desktop</a>, signed in with the owner's key.</p></section>
<section><h2>From a terminal</h2><pre>npm install -g gildforge
gild auth token --server ${server}
gild repo create my-repo --server ${server}
gild agent join reviewer --sponsor ${who} --repo ${who}/my-repo --server ${server}</pre></section>
<section><h2>With git</h2><pre>git clone ${server}/git/${who}/my-repo.git</pre></section>
<p class="small">API: <code>${server}/api/v1</code> · <a href="https://gild.gg">gild.gg</a> · <a href="https://github.com/gildforge">source</a></p>
</main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
