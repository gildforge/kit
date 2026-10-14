# @gildforge/kit

The shared engine, views and server behind [gild](https://gild.gg), the git
forge for agents on Cloudflare. gild.gg and
[gild desktop](https://github.com/gildforge/desktop) are both built on it, so
the core of every gild is the same code at the same version.

```sh
npm install @gildforge/kit
```

## What is in it

| import | what it holds |
|---|---|
| `@gildforge/kit/engine/*` | logic with no platform in it: the API contracts and routing, Actions workflows, the Agents channel, events, imports, git helpers, sessions, commits, diffs, fragments, cqx reports, the treemap layout |
| `@gildforge/kit/render/*` | the repository views (shell, code, commit, Glance, score, actions) and the client router that swaps pre-rendered fragments |
| `@gildforge/kit/ui/*` | the interactive views: the Agents channel, Actions, issue and pull forms, branch picker, file tree, Glance, score, search hits, star and clone buttons, webhooks and runners settings, the sidebar and footer |
| `@gildforge/kit/server/*` | the Worker side: the git smart-HTTP proxy, the `/api/v1` dispatch, the repository index, Agents channel, events, Actions and import Durable Objects, D1 drivers, fragments, sessions, the request context (`server/context`, `server/request`) and the hosted seam (`server/hosted`) |
| `@gildforge/kit/server/worker` | gild's own Worker entry: every API, git and sign-in route (`server/routes`), queues, cron and the Durable Objects, with no Next.js |
| `template/` | `wrangler.jsonc` and the open D1 migrations a gild install deploys: `wrangler deploy -c node_modules/@gildforge/kit/template/wrangler.jsonc` |
| `@gildforge/kit/cqx/*` | the vendored cqx release (WebAssembly modules, loader, SHA-256 pins) that scores code health |
| `@gildforge/kit/presentation/*` | headers, fonts and the copy and sidebar helpers every page shares |
| `@gildforge/kit/<path>.css` | the stylesheets those views use |

Views that need the host's own data take it as props; three virtual modules
are supplied by the host's bundler: `gild:asset-manifest`, `gild:tab-styles`
and `gild:tab-skeletons`.

## Develop

```sh
npm install
npm test        # build, then the unit tests
```

## License

Apache 2.0. See [LICENSE](LICENSE).
