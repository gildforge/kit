The selective WASM modules, loader and catalog are unmodified assets from
[cqx v0.1.26](https://github.com/cqxai/cqx/releases/tag/v0.1.26). This replaces
the previous monolithic `cqx-5c21654` build.

`integrity.json` is the version pin and the expected SHA-256 inventory. The
release's original `SHA256SUMS` and `manifest.json` are committed alongside
the modules. Every application build and every Wrangler build verifies the
pin, release inventory, manifest module hashes and each binary's version,
identity and ABI. Builds need no CDN or network access.

To update, download the assets from the GitHub release, review the new trusted
checksum inventory and update the pin and vendored bytes together:

```sh
gh release download v<VERSION> --repo cqxai/cqx --dir .tmp/cqx-release-new \
  --pattern core.wasm --pattern c.wasm --pattern csharp.wasm \
  --pattern manifest.json --pattern SHA256SUMS --pattern '*.mjs'
node scripts/cqx-artifacts.mjs
```

`core.wasm` belongs to `gild-site`; `c.wasm` and `csharp.wasm` belong to
`gild-cqx-heavy`. The latter has no routes, preview URLs or workers.dev URL.
The main Worker opens an RPC scan only for C-family sources. Instances live
for one scan and are disposed after gather → resolve → emit → score → quote.
The core resolves the entire repository's layout and scores all facts once,
so language boundaries do not change findings or the weighted headline.

Local verification after `bun run build:cloudflare`:

```sh
bun run test:cqx:local
bun run test:cqx:revert
bun run test:cqx:bundles
bun run test:cqx:failures:revert
# Or preview the app and the internal Worker directly:
bunx wrangler dev --local -c wrangler.jsonc -c wrangler.cqx-heavy.jsonc
```

`test:cqx:local` reads the public avatest demos from gild.gg, records their
commit hashes, and copies their scoring inputs into disposable local Git
repositories. All scores, cache writes and screenshots use local workerd,
the actual service binding and the production Score page. No remote writes
occur. Evidence is saved to `.tmp/cqx-review`.

The score cache remains `<owner>/<repo>@<commit>#cqx-<version>:<reads-version>`.
Source, manifests and cqx.json are immutable at the commit. Parsing and
analysis happen only on a miss. cqx keeps single-language JSON unchanged;
mixed reports carry `languages` and the line-weighted headline from cqx #74.

The combined C-family payload is capped before RPC at 1,000 files and 5 MiB
of UTF-8 source. The heavy Worker repeats the same guard before instantiating
WASM. These caps admit cJSON and Polly but reject the doubled Polly fixture
that consumes 88.25 MiB of WASM memory before JavaScript/RPC overhead; see
[measurements](../docs/cqx/limits-measurements.json). Both Workers explicitly
set `limits.cpu_ms` to 30,000 (the Workers Paid default), leaving headroom over
the measured demos without permitting unbounded CPU. The heavy Worker pins
`nodejs_compat` and `rpc` explicitly; no separate Symbol.dispose flag exists.
See [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
and [limits](https://developers.cloudflare.com/workers/platform/limits/).

Heavy failure or an over-limit payload preserves other-language scores with
an explicit partial note. C-only failures render a note with no dials/bars.
Partial results never enter either the commit-score or repository-list headline cache;
retrying the same commit after recovery can produce and cache a complete score.
Commit/PR deltas require complete coverage on both sides.

The only deployment command is `npm run deploy`: build the main app, deploy
`gild-cqx-heavy` with `wrangler deploy -c wrangler.cqx-heavy.jsonc`, then deploy
`gild-site`. Every stage uses `&&`; heavy failure prevents main deployment.
Workers Builds runs `npm run build:cloudflare`, followed by
`npx wrangler deploy -c wrangler.cqx-heavy.jsonc && npx wrangler deploy`. The
heavy service must be in the same account as the main Worker. This review
performed no deployment.

-codex
