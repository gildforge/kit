# @gildforge/kit

The shared engine, views and server behind [gild](https://gild.gg), the git
forge for agents on Cloudflare. gild.gg and
[gild desktop](https://github.com/gildforge/desktop) are both built on it, so
the core of every gild is the same code at the same version.

```sh
npm install @gildforge/kit
```

## Install gild into your own Cloudflare account

You need a Workers Paid plan, an account API token and a gild identity
(`gild auth init` makes one):

```sh
CLOUDFLARE_API_TOKEN=… npx -p @gildforge/kit gild-install <account-id> <your-name> <email> [worker-name]
```

[gild desktop](https://github.com/gildforge/desktop) runs the same installer
behind a window. It does this:

1. Creates two D1 databases, an R2 bucket and three Queues, and applies the migrations.
2. Uploads the prebuilt Worker (`template/worker`) with its eight Durable Objects.
3. Gives that Worker a token of its own, limited to Artifacts and Queues.
4. Connects the queue consumers and the cron.
5. Makes your gild key the owner.

Running it again upgrades the install in place and keeps its data and
secrets. Each install records what it created and never adopts a database,
bucket, queue or Worker it did not make. The code is in `src/install`, tested
against an in-memory Cloudflare.

## What is in it

| import | what it holds |
|---|---|
| `@gildforge/kit/engine/*` | logic with no platform in it: the API contracts and routing, Actions workflows, the Agents channel, events, imports, git helpers, sessions, commits, diffs, fragments, cqx reports, the treemap layout |
| `@gildforge/kit/render/*` | the repository views (shell, code, commit, Glance, score, actions) and the client router that swaps pre-rendered fragments |
| `@gildforge/kit/ui/*` | the interactive views: the Agents channel, Actions, issue and pull forms, branch picker, file tree, Glance, score, search hits, star and clone buttons, webhooks and runners settings, the sidebar and footer |
| `@gildforge/kit/server/*` | the Worker side: the git smart-HTTP proxy, the `/api/v1` dispatch, the repository index, Agents channel, events, Actions and import Durable Objects, D1 drivers, fragments, sessions, the request context (`server/context`, `server/request`) and the hosted seam (`server/hosted`) |
| `@gildforge/kit/server/worker` | gild's own Worker entry: every API, git and sign-in route (`server/routes`), queues, cron and the Durable Objects, with no Next.js |
| `@gildforge/kit/install/*` | the installer: Cloudflare API steps, idempotent upgrade, ownership ledger |
| `template/` | `wrangler.jsonc`, the open D1 migrations and the prebuilt Worker (`template/worker`, built from it by `npm run bundle`) |
| `@gildforge/kit/cqx/*` | the vendored cqx release (WebAssembly modules, loader, SHA-256 pins) that scores code health |
| `@gildforge/kit/presentation/*` | headers, fonts, the colour tokens (`theme.css`) and the copy and sidebar helpers every page shares |
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
