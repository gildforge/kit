import { installRepoTabs } from './repo-tabs.js'
import { publicPageNavigation } from '../engine/public-page-route.js'
import { bindCopy } from '../presentation/copy.js'
import { installScroll, pushURL, finishScroll, pendingScroll, pauseScroll, saveScroll } from './scroll.js'
import { numberLines } from './lines.js'
import { PENDING_HTML } from './pending.js'
import { contextHTML } from './context.js'
import { selectedAttribute, scoreCategory, selectHTML } from './selection.js'
import { fragmentURL, RENDER_VERSION, type Fragment } from './address.js'
import { intentPrefetch, safeLink, mayPrefetch } from './prefetch.js'
import type { TabClient } from './tab-client-contract.js'
import type { PagePointer, TipManifest } from '../engine/fragments.js'
interface LocalFile {
  html: string
  content: string
  file: TipManifest['files'][number]
}
interface View {
  pointer: PagePointer
  html: string
  page: 'code' | 'score' | 'commit'
  localFile?: boolean
}
let teardown: (() => void) | undefined
let pointer: PagePointer | null = null,
  manifest: TipManifest | null = null,
  principal = '',
  source: Worker | undefined,
  sourceVersion = '',
  seq = 0,
  displayedTip = '',
  activePage = 'code'
const pages = new Map<string, Promise<string>>()
const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >(),
  fragments = new Map<string, Promise<string>>(),
  views = new Map<string, Promise<View>>()
let assetManifest: Promise<Record<string, string>> | undefined
async function assetURL(name: string, version = RENDER_VERSION) {
  const inline = document.querySelector('#gild-assets')?.textContent
  if (inline) return (JSON.parse(inline) as Record<string, string>)[name]
  assetManifest ??= fetch('/gild-fragments/manifest.json').then(r => {
    if (!r.ok) throw new Error('Asset manifest unavailable')
    return r.json()
  })
  return (await assetManifest)[name] ?? `/gild-fragments/${version}/${name}`
}
async function ask<T>(op: string, p: PagePointer, extra: object = {}): Promise<T> {
  if (source && sourceVersion !== p.version) {
    source.terminate()
    for (const job of pending.values())
      job.reject(new Error('Renderer version changed'))
    pending.clear()
    source = undefined
  }
  sourceVersion = p.version
  const workerURL = await assetURL('source-worker.js', p.version)
  source ??= new Worker(workerURL, {
    type: 'module',
  })
  source.onmessage = (e) => {
    const job = pending.get(e.data.id)
    if (!job) return
    pending.delete(e.data.id)
    if (e.data.error) job.reject(new Error(e.data.error))
    else job.resolve(e.data.value)
  }
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    source!.postMessage({ id, op, pointer: p, principal, ...extra })
  })
}
export async function clearPrivateSources() {
  const channel = new BroadcastChannel('gild-private-source')
  channel.postMessage('clear')
  channel.close()
  if (pointer) await ask('clear-private', pointer)
  else {
    const worker = new Worker(
      await assetURL('source-worker.js'),
      { type: 'module' },
    )
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e) =>
        e.data.error ? reject(new Error(e.data.error)) : resolve()
      worker.postMessage({ id: 1, op: 'clear-private', pointer: { scope: '' } })
    })
    worker.terminate()
  }
  fragments.clear()
  views.clear()
  manifest = null
  document.dispatchEvent(new Event('gild:private-cleared'))
}
export function codeRoute(url: URL) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (
    parts.length < 2 ||
    parts.length > 4 ||
    [
      'api',
      'auth',
      'git',
      'settings',
      'orgs',
      'docs',
      'f',
      'pf',
      'gild-fragments',
    ].includes(parts[0]) ||
    parts[1].endsWith('.git')
  )
    return null
  if (parts.length === 2)
    return { repository: `${parts[0]}/${parts[1]}`, page: 'code' as const }
  if (parts.length === 3 && parts[2] === 'score')
    return { repository: `${parts[0]}/${parts[1]}`, page: 'score' as const }
  if (
    parts.length === 4 &&
    parts[2] === 'commit' &&
    /^[a-f0-9]{4,40}$/.test(parts[3])
  )
    return {
      repository: `${parts[0]}/${parts[1]}`,
      page: 'commit' as const,
      sha: parts[3],
    }
  return null
}
async function fetchFragment(
  p: PagePointer,
  f: Fragment,
  path = p.path,
  sha = p.tip,
) {
  const scope = f.kind === 'shell' ? '' : p.scope
  const url = new URL(
    fragmentURL({ ...f, version: p.version }, scope ? p.repository : undefined),
    location.origin,
  )
  url.search = new URLSearchParams({ repo: p.repository, sha, path }).toString()
  const key = `${scope}/${scope ? principal : ''}/${p.version}/${f.kind}/${f.hash}`
  if (!fragments.has(key)) {
    const load = fetch(url)
      .then(async (r) => {
        if (r.status === 202) throw new Error('Pending')
        if (!r.ok) throw new Error(`Fragment ${r.status}`)
        return r.text()
      })
      .catch((e) => {
        fragments.delete(key)
        throw e
      })
    fragments.set(key, load)
    if (fragments.size > 100) fragments.delete(fragments.keys().next().value!)
  }
  return fragments.get(key)!
}
const context: typeof contextHTML = (html, p, dir) => contextHTML(numberLines(html), p, dir)
function localPointer(url: URL): PagePointer | null {
  if (
    !pointer ||
    !manifest ||
    codeRoute(url)?.repository !== pointer.repository ||
    (url.searchParams.get('ref') ?? pointer.ref) !== pointer.ref ||
    codeRoute(url)?.page !== 'code'
  )
    return null
  const requestedPath = url.searchParams.get('path') ?? ''
  if (!requestedPath) {
    const readme = manifest.files.find((f) => f.readme)
    if (readme)
      return { ...pointer, path: readme.path, selected: readme.readme! }
  }
  const path = requestedPath,
    file = manifest.files.find((f) => f.path === path),
    tree = manifest.trees.find((t) => t.path === path)
  if (!file && !tree && path) return null
  return {
    ...pointer,
    path,
    selected:
      file?.fragment ??
      (tree ? { kind: 'tree', hash: tree.hash } : pointer.selected),
  }
}
export async function prefetchBrowse(url: URL) {
  const route = codeRoute(url)
  if (!route) return false
  if (
    pointer &&
    !document.querySelector('[data-artifact-pending]') &&
    route.page !== 'code' &&
    new URL(location.href).pathname === url.pathname &&
    (url.searchParams.get('ref') ?? pointer.ref) === pointer.ref
  )
    return {
      pointer,
      html: document.querySelector('[data-page-body]')?.innerHTML ?? '',
      page: route.page,
    }
  const key = url.pathname + url.search
  if (views.has(key)) return views.get(key)!
  const load = (async (): Promise<View> => {
    const local = localPointer(url)
    if (
      local?.selected?.kind === 'tree' &&
      manifest?.treeHTML?.[local.selected.hash]
    )
      return {
        pointer: local,
        html: manifest.treeHTML[local.selected.hash],
        page: 'code',
      }
    if (local?.selected && local.selected.kind === 'blob') {
      const held = await ask<LocalFile | null>('file', local, {
        path: local.path,
      }).catch(() => null)
      if (held)
        return {
          pointer: local,
          html: held.html,
          page: 'code',
          localFile: true,
        }
    }
    let p = local
    if (!p) {
      const endpoint = new URL(
        `/api/fragments/${route.repository}`,
        location.origin,
      )
      endpoint.search = new URLSearchParams({
        page: route.page,
        ref: url.searchParams.get('ref') ?? '',
        path: url.searchParams.get('path') ?? '',
        ...(route.sha ? { sha: route.sha } : {}),
      }).toString()
      if (!url.searchParams.has('ref')) endpoint.searchParams.delete('ref')
      const r = await fetch(endpoint)
        if (r.status === 202) throw new Error('Pending')
        if (!r.ok) throw new Error(`Pointer ${r.status}`)
      p = (await r.json()) as PagePointer
    }
    let html = p.selected
      ? await fetchFragment(p, p.selected, p.path, route.sha ?? p.tip)
      : '<p>No README yet. Pick a file on the left to read it.</p>'
    if (p.score)
      html = html.replace(
        '<!--gild-score-->',
        await fetchFragment(p, p.score, '', route.sha ?? p.tip),
      )
    if (
      !pointer ||
      p.repository !== pointer.repository ||
      p.tip !== pointer.tip ||
      route.page !== 'code'
    )
      await fetchFragment(p, p.home)
    // Auto source prefetch is optional; an explicit click always has the file floor.
    if (mayPrefetch() && (!p.scope || principal))
      void ask<TipManifest>('preload', p)
        .then((m) => {
          if (pointer?.manifest.hash === m.tree) manifest = m
        })
        .catch(() => {})
    return { pointer: p, html, page: route.page }
  })().catch((e) => {
    views.delete(key)
    throw e
  })
  views.set(key, load)
  if (views.size > 100) views.delete(views.keys().next().value!)
  return load
}
function selections(url: URL) {
  for (const row of document.querySelectorAll<HTMLAnchorElement>(
    '[data-kind=blob] > a',
  ))
    if (row.dataset.onClass)
      row.classList.toggle(
        row.dataset.onClass,
        new URL(row.href).searchParams.get('path') ===
          url.searchParams.get('path'),
      )
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-category],[data-glance-root],[data-diff-path],[data-change-overview],[data-commit-overview]',
  )) {
    for (const name of [
      'data-category',
      'data-glance-root',
      'data-diff-path',
      'data-change-overview',
      'data-commit-overview',
    ])
      if (element.hasAttribute(name)) {
        const selected = selectedAttribute(
          name,
          element.getAttribute(name)!,
          url,
          element.closest<HTMLElement>('[data-score-default]')?.dataset
            .scoreDefault,
        )
        if (selected !== null) element.hidden = !selected
      }
  }
  const category = scoreCategory(
    url,
    document.querySelector<HTMLElement>('[data-score-default]')?.dataset
      .scoreDefault,
  )
  if (category)
    for (const dial of document.querySelectorAll<HTMLElement>(
      '[data-score-category]',
    )) {
      const active = dial.dataset.scoreCategory === category
      dial.setAttribute('aria-current', String(active))
      dial.classList.toggle(dial.dataset.onClass!, active)
    }
  for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]'))
    tab.setAttribute(
      'aria-current',
      tab.dataset.tab === (codeRoute(url)?.page === 'commit' ? 'code' : codeRoute(url)?.page ?? url.pathname.split('/')[3] ?? 'code') ? 'page' : 'false',
    )
}
let islandGeneration = 0
// The first page's viewer state arrives inside its own response (the Worker
// appends it from the batch that decided the page's privacy): no fetch.
let consumedIslands: Element | null = null
function initialIslands(repository: string) {
  const inline = document.querySelector('#gild-islands')
  if (!inline || inline === consumedIslands) return null
  consumedIslands = inline
  const data = inline.textContent ? JSON.parse(inline.textContent) as { repository: string } : null
  return data && data.repository.toLowerCase() === repository.toLowerCase() ? data : null
}
async function islands(p: PagePointer) {
  const generation = ++islandGeneration
  const commit = codeRoute(new URL(location.href)),
    commitSha = commit?.page === 'commit' ? commit.sha : undefined
  const inline = commitSha ? null : initialIslands(p.repository)
  const r = inline ? null : await fetch(
    `/api/repos/${p.repository}/islands${commitSha ? '?commit=' + commitSha : ''}`,
    { cache: 'no-store' },
  ).catch(() => null)
  if (!inline && (!r || !r.ok)) return
  const data = (inline ?? await r!.json().catch(() => null)) as {
    name: string | null
    count: number
    starred: boolean
    write: boolean
    picture?: { url?: string }
    runs: Parameters<typeof import('./commit-client.js').mountCommit>[2]
    receipts: Parameters<typeof import('./commit-client.js').mountCommit>[3]
  }
  if (!data || generation !== islandGeneration) return
  if (commitSha) {
    const moduleURL = new URL(
      await assetURL('commit-client.js', p.version),
      location.origin,
    ).href
    void import(/* webpackIgnore: true */ moduleURL)
      .then(({ mountCommit }) => {
        if (generation === islandGeneration)
          mountCommit(
            p.repository,
            commitSha,
            data.runs ?? [],
            data.receipts ?? [],
          )
      })
      .catch(() => {})
  }
  principal = data.name ?? ''
  const identity = document.querySelector('[data-identity]')
  const signIn = identity?.querySelector<HTMLAnchorElement>('.site-signin')
  if (signIn) signIn.href = '/auth/device?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
  if (identity && data.name) {
    const link = document.createElement('a')
    link.href = '/dashboard'
    link.className = 'site-identity'
    const label = document.createElement('span')
    label.className = 'identity-label'
    label.textContent = label.title = '@' + data.name
    link.append(label)
    if (data.picture?.url) {
      const image = document.createElement('img')
      image.src = data.picture.url
      image.width = image.height = 22
      image.alt = ''
      link.prepend(image)
    }
    identity.replaceChildren(link)

  }
  const starSlot = document.querySelector<HTMLElement>('[data-star-slot]')
  if (starSlot) {
    if (data.name) {
      const moduleURL = new URL(await assetURL('identity-client.js', p.version), location.origin).href
      const { mountStar } = await import(/* webpackIgnore: true */ moduleURL)
      mountStar(starSlot, p.repository, data.count, data.starred)
    } else {
      const count = starSlot.querySelector<HTMLElement>('[data-star-count]')
      if (count) { count.textContent = `☆ ${data.count}`; count.setAttribute('aria-label', `${data.count} stars`); count.title = `${data.count} stars` }
      const signIn = starSlot.querySelector<HTMLAnchorElement>('a')
      if (signIn) signIn.href = '/auth/device?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
    }
  }
  const settings = document.querySelector<HTMLElement>('[data-settings]')
  if (settings) settings.hidden = !data.write
  if (p.scope && principal && mayPrefetch())
    void ask<TipManifest>('preload', p)
      .then((m) => {
        manifest = m
        void expandSelected().then(() => {
          folders()
          selections(new URL(location.href))
        })
        document.documentElement.dataset.sourceReady = m.tree
      })
      .catch((error) => {
        document.documentElement.dataset.sourceError = error.message
      })
}
async function navigate(url: URL, mode: 'push' | 'restore' | 'preserve' = 'push') {
  // A fresh document isolates Next's hydration, module cache and global
  // handlers from the independent fragment application in both directions.
  const root = document.querySelector<HTMLElement>('[data-fragment-root]')
  if (!root) { saveScroll(); location.assign(url); return }
  pauseScroll()
  const current = new URL(location.href),
    route = codeRoute(url)
  if (
    pointer &&
    !document.querySelector('[data-artifact-pending]') &&
    route?.page !== 'code' &&
    current.pathname === url.pathname &&
    (url.searchParams.get('ref') ?? pointer.ref) === pointer.ref
  ) {
    const scrollYBefore = window.scrollY
    if (mode === 'push') pushURL(url)
    finishScroll(url, mode, scrollYBefore)
    selections(url)
    document.documentElement.dataset.navigationReady = url.pathname + url.search + url.hash
    return
  }
  let view: View
  try { view = (await prefetchBrowse(url)) as View }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'Pending' || !route || !pointer || route.repository !== pointer.repository) throw error
    const pane = route.page === 'code' && activePage === 'code' ? root.querySelector('[data-file-pane]') : root.querySelector('[data-page-body]')
    if (!pane) throw error
    const previousY = scrollY
    if (mode === 'push') pushURL(url)
    pane.innerHTML = PENDING_HTML
    selections(url)
    finishScroll(url, mode, previousY)
    delete document.documentElement.dataset.navigationReady
    document.dispatchEvent(new Event('gild:tab-pending'))
    return
  }
  if (
    view.page === 'commit' &&
    view.pointer.selected?.hash &&
    route?.sha !== view.pointer.selected.hash
  )
    url.pathname = `/${view.pointer.repository}/commit/${view.pointer.selected.hash}`
  const p = view.pointer,
    sameCode =
      pointer?.repository === p.repository &&
      displayedTip === p.tip &&
      activePage === 'code' &&
      view.page === 'code'
  const scrollYBefore = window.scrollY
  if (mode === 'push') pushURL(url)
  else if (mode === 'preserve' && url.href !== current.href)
    History.prototype.replaceState.call(history, history.state, '', url)
  if (sameCode) {
    const pane = root.querySelector<HTMLElement>('[data-file-pane]')!
    pane.innerHTML = context(
      view.html,
      p,
      p.selected?.kind === 'tree' ? p.path : '',
    )
    const name = root.querySelector('[data-file-name]')
    if (name) name.textContent = p.path
  } else {
    let home = context(await fetchFragment(p, p.home), p)
    if (view.page === 'code')
      home = home.replace(
        '<!--gild-file-->',
        context(view.html, p, p.selected?.kind === 'tree' ? p.path : ''),
      )
    else {
      const at = home.indexOf('<div data-page-body="">')
      home =
        home.slice(0, at + '<div data-page-body="">'.length) +
        selectHTML(context(view.html, p), url) +
        '</div></div>'
    }
    root.innerHTML = home
    const name = root.querySelector('[data-file-name]')
    if (name) name.textContent = p.path
    void islands(p)
  }
  pointer = p
  displayedTip = p.tip
  activePage = view.page
  await expandSelected()
  selections(url)
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-return-to]')) link.href = '/auth/device?next=' + encodeURIComponent(url.pathname + url.search + url.hash)
  folders()
  finishScroll(url, mode, scrollYBefore)
  document.documentElement.dataset.navigationReady = url.pathname + url.search + url.hash
  const bootPointer = document.querySelector('#gild-pointer')
  if (bootPointer) bootPointer.textContent = JSON.stringify(pointer)
  document.dispatchEvent(new Event('gild:navigated'))
}
async function expandSelected() {
  if (!pointer || activePage !== 'code') return
  const parts = pointer.path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const path = parts.slice(0, i).join('/'),
      row = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-tree-root] [data-kind=tree]',
        ),
      ].find(
        (r) =>
          new URL(
            r.querySelector<HTMLAnchorElement>('a')!.href,
          ).searchParams.get('path') === path,
      )
    if (!row) continue
    const children = row.querySelector<HTMLElement>('[data-children]')!
    if (!children.childElementCount)
      children.innerHTML = context(
        manifest?.treeHTML?.[row.dataset.hash!] ??
          (await fetchFragment(pointer, {
            kind: 'tree',
            hash: row.dataset.hash!,
          })),
        pointer,
        path,
      )
    children.hidden = false
    row.querySelector('a')!.setAttribute('aria-expanded', 'true')
  }
}
function folders() {
  document.querySelectorAll<HTMLElement>('[data-kind=tree]').forEach((row) => {
    const link = row.querySelector<HTMLAnchorElement>('a')!,
      children = row.querySelector<HTMLElement>('[data-children]')!
    link.onclick = async (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return
      event.preventDefault()
      event.stopPropagation()
      if (!pointer) return
      if (children.childElementCount) {
        children.hidden = !children.hidden
        link.setAttribute('aria-expanded', String(!children.hidden))
        return
      }
      const path =
        new URL(link.href).searchParams.get('path') ?? row.dataset.entry!
      children.innerHTML = context(
        manifest?.treeHTML?.[row.dataset.hash!] ??
          (await fetchFragment(pointer, {
            kind: 'tree',
            hash: row.dataset.hash!,
          })),
        pointer,
        path,
      )
      children.hidden = false
      link.setAttribute('aria-expanded', 'true')
      folders()
    }
  })
}
export function boot(nextPrefetch?: (url: URL) => void) {
  teardown?.()
  const stopScroll = installScroll()
  const stopCopy = bindCopy(document)
  const controller = new AbortController(),
    signal = controller.signal,
    channel = new BroadcastChannel('gild-private-source')
  channel.onmessage = (event) => {
    if (event.data === 'clear') {
      fragments.clear()
      views.clear()
      manifest = null
      principal = ''
      if (pointer?.scope) {
        document.querySelector('[data-fragment-root]')?.replaceChildren()
        pointer = null
      }
      document.dispatchEvent(new Event('gild:private-cleared'))
    }
  }
  const json = document.querySelector('#gild-pointer')?.textContent
  if (json) {
    pointer = JSON.parse(json) as PagePointer
    displayedTip = pointer.tip
    activePage = codeRoute(new URL(location.href))?.page ?? 'code'
    void islands(pointer)
    if (!pointer.scope && mayPrefetch()) {
      const initialPointer = pointer
      // Two frames let the stored HTML paint; the idle callback runs after load.
      const preload = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        const work = () => void ask<TipManifest>('preload', initialPointer)
        .then((m) => {
          manifest = m
          void expandSelected().then(() => {
            folders()
            selections(new URL(location.href))
          })
          document.documentElement.dataset.sourceReady = m.tree
        })
        .catch((error) => {
          document.documentElement.dataset.sourceError = error.message
        })
        if ('requestIdleCallback' in window) window.requestIdleCallback(work, { timeout: 2000 })
        else setTimeout(work, 0)
      }))
      if (document.readyState === 'complete') preload()
      else window.addEventListener('load', preload, { once: true, signal })
    }
  }
  let tabClient:Promise<TabClient>|undefined, mountedTabClient:TabClient|undefined
  // A repository marker is also present in Next's dynamic layout. Only the
  // renderer/publication's explicit root flag grants this application ownership.
  const standaloneRepo = document.documentElement.hasAttribute('data-repo-router') && document.querySelector('[data-repository]')
  const client = () => tabClient ??= assetURL('tab-client.js').then(path=>import(/* webpackIgnore: true */ new URL(path,location.origin).href))
  const mount = async () => {
    // The search palette is an island on every page, Code included.
    if (!document.querySelector('[data-repo-island], .search-trigger')) return
    const module = await client()
    mountedTabClient = module
    module.mountTabs(document, clearPrivateSources, localSearch)
  }
  const tabs = !nextPrefetch && standaloneRepo ? installRepoTabs({
    selected:selections,
    committed(p,tab){
      pointer=p;activePage=tab;displayedTip=p?.tip??''
      folders();if(p)void expandSelected()
      void islands(p ?? {repository:document.querySelector<HTMLElement>('[data-repository]')!.dataset.repository!,version:RENDER_VERSION,scope:''} as PagePointer)
    },
    mount,
    async prefetched(tab,current,html){if(tab==='agents'){const module=await client();if(current())await module.prefetchTab(document.querySelector<HTMLElement>('[data-repository]')!.dataset.repository!,tab,html)}},
    unmount(){mountedTabClient?.unmountTabs()},
  },signal) : undefined
  // The account shell remains interactive even before a repository projection
  // exists. Its lifecycle does not depend on unfinished repository content.
  if (!tabs && !nextPrefetch && document.documentElement.hasAttribute('data-repo-router')) void mount().catch(() => {})
  // Next-rendered public tabs have no pointer until a Code payload is selected.
  if(!json && standaloneRepo)void islands({repository:document.querySelector<HTMLElement>('[data-repository]')!.dataset.repository!,version:RENDER_VERSION,scope:''} as PagePointer)
  const stopPrefetch = intentPrefetch(async (url) => {
    if (tabs && document.querySelector<HTMLElement>('[data-repository]')?.dataset.repository === url.pathname.split('/').filter(Boolean).slice(0,2).join('/') && !url.searchParams.has('path')) await tabs.prefetch(url)
    else if (codeRoute(url)) await prefetchBrowse(url)
    else if (nextPrefetch && !publicPageNavigation(url)) nextPrefetch(url)
    else {
      if (!pages.has(url.href))
        pages.set(
          url.href,
          fetch(url, { headers: { 'x-gild-prefetch': 'intent' } })
            .then(async (response) => {
              if (
                !response.ok || response.headers.get('x-gild-state') === 'pending' ||
                !response.headers.get('content-type')?.startsWith('text/html')
              )
                throw new Error('HTML page unavailable')
              return response.text()
            })
            .catch((error) => {
              pages.delete(url.href)
              throw error
            }),
        )
      await pages.get(url.href)
      if (pages.size > 40) pages.delete(pages.keys().next().value!)
    }
  })
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      // Pending's explicit retry targets this same URL. Keep it in this
      // application so it reads the prepared artifact without a document load.
      const pendingRetry = event.target instanceof Element && !!event.target.closest('[data-pending-retry]')
      const found = safeLink(event.target, true, pendingRetry)
      if (!found) return
      // An empty href otherwise resolves without this document's hash. The
      // explicit retry means the complete current selection, including hash.
      if (pendingRetry && found.link.getAttribute('href') === '') found.url = new URL(location.href)
      const route = codeRoute(found.url)
      if (!route) return
      // A different repository starts a new document/application ownership.
      if (tabs && route.repository !== document.querySelector<HTMLElement>('[data-repository]')?.dataset.repository) return
      // Folder expansion has its own immutable tree fetch.
      if (
        found.link.closest('[data-kind]')?.getAttribute('data-kind') === 'tree'
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      const mode = pendingRetry && found.url.href === location.href ? 'preserve' : 'push'
      void navigate(found.url, mode).catch((error) => {
        document.dispatchEvent(
          new CustomEvent('gild:navigation-error', { detail: error.message }),
        )
        location.assign(found.url)
      })
    },
    { capture: true, signal },
  )
  window.addEventListener(
    'popstate',
    () => {
      if (codeRoute(new URL(location.href)))
        void navigate(new URL(location.href), 'restore').catch(() =>
          location.reload(),
        )
      else if (!nextPrefetch) { pendingScroll(history.state?.gildScrollY ?? 0); pauseScroll(); location.reload() }
    },
    { signal },
  )
  document.addEventListener(
    'change',
    (event) => {
      if (!(event.target instanceof HTMLSelectElement) || !event.target.hasAttribute('data-branch')) return
      const url = new URL(location.href)
      url.search = new URLSearchParams({
        ref: (event.target as HTMLSelectElement).value,
      }).toString()
      manifest = null
      views.clear()
      void navigate(url).catch(() => location.assign(url))
    },
    { signal },
  )
  window.addEventListener('focus', () => void refreshTip().catch(() => {}), {
    signal,
  })
  const media = matchMedia('(prefers-color-scheme: dark)'),
    applyTheme = () => {
      const choice = localStorage.getItem('gild.theme') ?? 'dark'
      document.documentElement.dataset.theme =
        choice === 'system' ? (media.matches ? 'dark' : 'light') : choice
    }
  media.addEventListener(
    'change',
    () => {
      if (localStorage.getItem('gild.theme') === 'system') applyTheme()
    },
    { signal },
  )
  document.querySelector('[data-theme-toggle], .site-footer-grid button')?.addEventListener(
    'click',
    () => {
      const choice = localStorage.getItem('gild.theme') ?? 'dark'
      localStorage.setItem(
        'gild.theme',
        choice === 'dark' ? 'light' : choice === 'light' ? 'system' : 'dark',
      )
      applyTheme()
    },
    { signal },
  )
  document
    .querySelector('[data-search], .search-trigger')
    ?.addEventListener('click', () => search(), { signal })
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key === '/' &&
        !document.querySelector('[data-search-ready]') &&
        !(
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
      ) {
        event.preventDefault()
        search()
      }
    },
    { signal },
  )
  selections(new URL(location.href))
  folders()
  document.documentElement.dataset.fragmentRouter = 'ready'
  teardown = () => {
    stopPrefetch()
    stopScroll()
    stopCopy()
    controller.abort()
    channel.close()
  }
  return teardown
}
async function refreshTip() {
  if (!pointer || !document.querySelector('[data-fragment-root]')) return
  const url = new URL(location.href),
    route = codeRoute(url)
  if (!route) return
  const endpoint = new URL(
    `/api/fragments/${pointer.repository}`,
    location.origin,
  )
  endpoint.search = new URLSearchParams({
    ref: pointer.ref,
    path: url.searchParams.get('path') ?? '',
    page: route.page,
    ...(route.sha ? { sha: route.sha } : {}),
  }).toString()
  const response = await fetch(endpoint, { cache: 'no-store' })
  if (!response.ok) {
    if(response.status===404){await clearPrivateSources();pointer=null;document.querySelector('[data-fragment-root]')?.replaceChildren(Object.assign(document.createElement('p'),{textContent:'Repository not found'}))}
    return
  }
  const next = (await response.json()) as PagePointer
  if (
    next.tip === pointer.tip &&
    next.meta === pointer.meta &&
    next.home.hash === pointer.home.hash
  )
    return
  views.clear()
  // Blob/tree/home keys include every immutable input. Keep these across tips;
  // only mutable name lookups become stale after a push.
  document.dispatchEvent(new Event('gild:tip-changed'))
  if (mayPrefetch() && (!next.scope || principal))
    manifest = await ask<TipManifest>('preload', next)
  else manifest = null
  if (location.href !== url.href) return
  pointer = next
  await navigate(url, 'preserve')
  if (manifest) document.documentElement.dataset.sourceReady = manifest.tree
}
/** The palette is the React search island. Before it commits, a click or /
 * is remembered and the island opens itself as soon as it lands. */
/** In-repo search over the sources this browser already holds; null sends the palette to the index. */
async function localSearch(query: string) {
  if (!pointer || !manifest?.bundle) return null
  const ref = pointer.ref
  const hits = await ask<{ path: string; line: number; text: string }[]>('search', pointer, { query })
  return hits.map((hit) => ({ ...hit, ref }))
}
function search() {
  if (document.querySelector('[data-search-ready]')) return
  document.documentElement.dataset.searchWanted = ''
}

if (typeof document !== 'undefined' && (document.querySelector('#gild-pointer') || document.documentElement.hasAttribute('data-repo-router')))
  boot()
