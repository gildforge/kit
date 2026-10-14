import { repoTabRoute } from '../engine/repo-tab-route.ts'
import { safeLink, mayPrefetch } from './prefetch.ts'
import { pauseScroll, pushURL, finishScroll } from './scroll.ts'
import type { PagePointer } from '../engine/fragments.ts'
import skeletons from 'gild:tab-skeletons'
interface Payload {
  html: string
  pointer: PagePointer | null
  title: string
  viewer: string | null
}
interface Options {
  selected(url: URL): void
  committed(pointer: PagePointer | null, tab: string): void
  mount(): Promise<void>
  prefetched(tab: string, current: () => boolean, html: string): Promise<void>
  unmount(): void
}
/** A bounded, cancellable-by-generation router for the current repository.
 * Published documents are inert payloads: their Next scripts never execute. */
export function installRepoTabs(options: Options, signal: AbortSignal) {
  const repository =
    document.querySelector<HTMLElement>('[data-repository]')?.dataset.repository
  if (!repository) return
  const cache = new Map<string, Payload>(),
    loads = new Map<string, Promise<Payload>>(),
    styles = new Map<string, Promise<void>>()
  let generation = 0,
    renderedEpoch = 0,
    cacheEpoch = 0,
    displayed = new URL(location.href),
    bytes = 0
  const key = (url: URL) => url.pathname + url.search
  const body = () => document.querySelector<HTMLElement>('[data-page-body]')!
  const eligible = (url: URL) => repoTabRoute(url)?.repository === repository
  const remember = (url: URL, payload: Payload) => {
    const previous = cache.get(key(url))
    bytes -= previous?.html.length ?? 0
    cache.delete(key(url))
    cache.set(key(url), payload)
    bytes += payload.html.length
    while (cache.size > 30 || bytes > 8_000_000) {
      const first = cache.keys().next().value!
      bytes -= cache.get(first)!.html.length
      cache.delete(first)
    }
  }
  const snapshot = () => {
    // An invalidated document must not repopulate the cleared alias cache.
    if (renderedEpoch !== cacheEpoch) return
    if (
      !body() ||
      body().querySelector('[data-artifact-pending]') ||
      body().hasAttribute('data-navigation-pending') ||
      body().hasAttribute('data-navigation-error')
    )
      return
    const payload = {
      html: body().innerHTML,
      pointer: readPointer(document),
      title: document.title,
      viewer: document.querySelector('#gild-islands')?.textContent ?? null,
    }
    remember(displayed, payload)
    // The root URL and its explicit current-ref link name the same painted
    // body. Keep both keys so warming the tabs does not fetch Code again.
    if (payload.pointer && !displayed.searchParams.has('ref')) {
      const explicit = new URL(displayed)
      explicit.searchParams.set('ref', payload.pointer.ref)
      remember(explicit, payload)
    }
  }
  function readPointer(doc: ParentNode): PagePointer | null {
    const json = doc.querySelector('#gild-pointer')?.textContent
    return json ? JSON.parse(json) : null
  }
  let ref =
    readPointer(document)?.ref ?? new URL(location.href).searchParams.get('ref')
  const refLinks = () => {
    if (!ref) return
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      'nav[aria-label=Repository] a[data-tab=code], nav[aria-label=Repository] a[data-tab=score]',
    )) {
      const url = new URL(link.href)
      url.searchParams.set('ref', ref)
      link.href = url.pathname + url.search + url.hash
    }
  }
  const stylesheet = (href: string) => {
    const url = new URL(href, location.origin)
    if (url.origin !== location.origin) return Promise.resolve()
    if (styles.has(url.href)) return styles.get(url.href)!
    const existing = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'),
    ].find((l) => l.href === url.href)
    if (existing?.sheet) return Promise.resolve()
    const link =
      existing ??
      Object.assign(document.createElement('link'), {
        rel: 'stylesheet',
        href: url.href,
      })
    const loaded = new Promise<void>((resolve, reject) => {
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener(
        'error',
        () => {
          styles.delete(url.href)
          reject(Error('Tab stylesheet unavailable'))
        },
        { once: true },
      )
    })
    styles.set(url.href, loaded)
    if (!existing) document.head.append(link)
    return loaded
  }
  const load = (url: URL) => {
    if (cache.has(key(url))) return Promise.resolve(cache.get(key(url))!)
    if (loads.has(key(url))) return loads.get(key(url))!
    const epoch = cacheEpoch
    const pending = fetch(url, {
      headers: { 'x-gild-prefetch': 'repo-tab' },
      signal,
    })
      .then(async (response) => {
        if (response.headers.get('x-gild-state') === 'pending') throw Error('Pending')
        if (
          !response.ok ||
          !response.headers.get('content-type')?.includes('text/html')
        )
          throw Error(`Tab unavailable (${response.status})`)
        const doc = new DOMParser().parseFromString(
          await response.text(),
          'text/html',
        )
        if (doc.querySelector('[data-artifact-pending]')) throw Error('Pending')
        if (
          doc.querySelector<HTMLElement>('[data-repository]')?.dataset
            .repository !== repository ||
          !doc.querySelector('[data-page-body]')
        )
          throw Error('Tab content unavailable')
        // Start all CSS in parallel during payload prefetch. No scripts/Flight,
        // font discovery or Next chunks on the click path.
        await Promise.all(
          [
            ...doc.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'),
          ].map((l) => stylesheet(l.getAttribute('href')!)),
        )
        const payload = {
          html: doc.querySelector('[data-page-body]')!.innerHTML,
          pointer: readPointer(doc),
          title: doc.title,
          viewer: doc.querySelector('#gild-islands')?.textContent ?? null,
        }
        if (epoch === cacheEpoch) {
          remember(url, payload)
          document.dispatchEvent(
            new CustomEvent('gild:prefetched', { detail: url.href }),
          )
        }
        return payload
      })
      .finally(() => {
        if (loads.get(key(url)) === pending) loads.delete(key(url))
      })
    loads.set(key(url), pending)
    return pending
  }
  const commit = (
    url: URL,
    payload: Payload,
    mode: 'push' | 'restore',
    previousY: number,
  ) => {
    renderedEpoch = cacheEpoch
    body().innerHTML = payload.html
    body().removeAttribute('aria-busy')
    body().removeAttribute('data-navigation-pending')
    body().removeAttribute('data-navigation-error')
    body().style.minHeight = ''
    let pointer = document.querySelector('#gild-pointer')
    if (payload.pointer) {
      if (!pointer) {
        pointer = Object.assign(document.createElement('script'), {
          id: 'gild-pointer',
          type: 'application/json',
        })
        document.body.append(pointer)
      }
      pointer.textContent = JSON.stringify(payload.pointer)
    } else pointer?.remove()
    document.querySelector('#gild-islands')?.remove()
    if (payload.viewer) {
      const viewer = Object.assign(document.createElement('script'), { id: 'gild-islands', type: 'application/json', textContent: payload.viewer })
      document.body.append(viewer)
    }
    document.title = payload.title
    displayed = url
    ref = payload.pointer?.ref ?? ref
    refLinks()
    options.committed(payload.pointer, repoTabRoute(url)!.tab)
    options.selected(url)
    finishScroll(url, mode, previousY)
    document.documentElement.dataset.navigationReady = key(url) + url.hash
    document.dispatchEvent(new Event('gild:tab-committed'))
    void options.mount().catch(() => {})
    schedulePrefetch()
  }
  const navigate = (url: URL, mode: 'push' | 'restore' = 'push') => {
    if (!eligible(url)) return false
    if (
      mode === 'push' &&
      url.href === displayed.href &&
      url.href === location.href &&
      renderedEpoch === cacheEpoch &&
      !body().hasAttribute('data-navigation-pending') &&
      !body().querySelector('[data-artifact-pending]') &&
      !body().hasAttribute('data-navigation-error')
    ) {
      options.selected(url)
      document.documentElement.dataset.navigationReady = key(url) + url.hash
      return true
    }
    const id = ++generation,
      previousY = scrollY
    snapshot()
    pauseScroll()
    options.unmount()
    if (mode === 'push') pushURL(url)
    options.selected(url)
    delete document.documentElement.dataset.navigationReady
    const held = cache.get(key(url))
    if (held) {
      commit(url, held, mode, previousY)
      return true
    }
    const tab = repoTabRoute(url)!.tab
    body().setAttribute('aria-busy', 'true')
    body().removeAttribute('data-navigation-error')
    body().dataset.navigationPending = tab
    body().style.minHeight = ''
    body().innerHTML = `<div data-tab-skeleton="${tab}" role="status" aria-label="Loading ${tab}">${(skeletons as Record<string, string>)[tab]}</div>`
    if (mode === 'push') scrollTo(0, 0)
    void load(url)
      .then((payload) => {
        if (id === generation) commit(url, payload, mode, previousY)
      })
      .catch((error) => {
        if (id !== generation || signal.aborted) return
        body().removeAttribute('aria-busy')
        body().removeAttribute('data-navigation-pending')
        const pending = error.message === 'Pending'
        if (!pending) body().setAttribute('data-navigation-error', '')
        body().style.minHeight = ''
        const message = document.createElement('p'),
          retry = document.createElement('button')
        message.role = pending ? 'status' : 'alert'
        if (pending) message.dataset.artifactPending = ''
        message.textContent = pending ? 'Pending. This view is being prepared in the background. ' : 'Could not load this tab. '
        retry.textContent = pending ? 'Check again' : 'Retry'
        retry.onclick = () => navigate(url, 'restore')
        message.append(retry)
        body().replaceChildren(message)
        finishScroll(url, mode, previousY)
        document.dispatchEvent(
          new CustomEvent(pending ? 'gild:tab-pending' : 'gild:navigation-error', { detail: error.message }),
        )
      })
    return true
  }
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const found = safeLink(event.target, true, true)
      if (
        !found ||
        !eligible(found.url) ||
        found.link.closest('[data-kind=tree]') ||
        (found.url.searchParams.has('path') &&
          !found.link.closest('nav[aria-label=Repository]'))
      )
        return
      // Browsing within Code (including returning from a file to its README)
      // uses the existing local source bundle, not a tab/body replacement.
      if (repoTabRoute(displayed)?.tab === 'code' && repoTabRoute(found.url)?.tab === 'code' && found.url.href !== location.href && renderedEpoch === cacheEpoch && !body().hasAttribute('data-navigation-pending') && !body().hasAttribute('data-navigation-error')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      navigate(found.url)
    },
    { capture: true, signal },
  )
  window.addEventListener(
    'popstate',
    (event) => {
      if (eligible(new URL(location.href))) {
        if (repoTabRoute(displayed)?.tab === 'code' && repoTabRoute(new URL(location.href))?.tab === 'code' && renderedEpoch === cacheEpoch) return
        event.stopImmediatePropagation()
        navigate(new URL(location.href), 'restore')
      }
    },
    { signal },
  )
  const attempted = new Set<string>(), queued = new Map<string, Promise<Payload>>()
  const queue: {
    url: URL
    resolve: (payload: Payload) => void
    reject: (error: unknown) => void
  }[] = []
  let inFlight = 0
  const clearQueue = () => {
    for (const job of queue.splice(0)) {
      queued.delete(key(job.url))
      job.reject(Error('Prefetch invalidated'))
    }
  }
  const pump = () => {
    while (mayPrefetch() && !signal.aborted && inFlight < 2 && queue.length) {
      const job = queue.shift()!
      queued.delete(key(job.url))
      inFlight++
      void load(job.url)
        .then((payload) => {
          // Only a current, successfully cached speculative payload may prime
          // its viewer island. Invalidated fills cannot restart private reads.
          if (cache.has(key(job.url)) && mayPrefetch() && !signal.aborted)
            {
              const epoch = cacheEpoch
              void options.prefetched(repoTabRoute(job.url)!.tab, () => epoch === cacheEpoch && !signal.aborted, payload.html).catch(() => {})
            }
          job.resolve(payload)
        }, job.reject)
        .finally(() => {
          inFlight--
          pump()
        })
    }
  }
  const prefetch = (url: URL): Promise<Payload | void> => {
    if (!eligible(url) || !mayPrefetch() || signal.aborted)
      return Promise.resolve()
    if (cache.has(key(url))) return Promise.resolve(cache.get(key(url)))
    if (loads.has(key(url))) return loads.get(key(url))!
    if (queued.has(key(url))) return queued.get(key(url))!
    // Missing publications must not be retried on every local file navigation.
    // Explicit clicks still retry through load(); invalidation resets intent.
    if (attempted.has(key(url))) return Promise.resolve()
    if (queue.length >= 12) return Promise.reject(Error('Prefetch queue full'))
    const pending = new Promise<Payload>((resolve, reject) =>
      queue.push({ url, resolve, reject }),
    )
    attempted.add(key(url))
    while (attempted.size > 30) attempted.delete(attempted.values().next().value!)
    queued.set(key(url), pending)
    pump()
    return pending
  }
  function schedulePrefetch() {
    if (!mayPrefetch() || signal.aborted) return
    // Warm only adjacent tabs automatically. Loading every authorized tab
    // competes with the current page; other destinations warm on user intent.
    const links = [...document.querySelectorAll<HTMLAnchorElement>(
      'nav[aria-label=Repository] a[data-tab]',
    )].filter(link => !link.hidden && eligible(new URL(link.href)))
    const current = links.findIndex(link => link.dataset.tab === repoTabRoute(displayed)?.tab)
    if (current < 0) return
    for (const link of [links[(current + 1) % links.length], links[(current + links.length - 1) % links.length]]) {
      const url = new URL(link.href)
      if (eligible(url)) void prefetch(url).catch(() => {})
    }
  }
  const intent = (event: Event) => {
    const found = safeLink(event.target)
    // Source file/folder intent belongs to the existing local bundle router.
    if (found && !found.url.searchParams.has('path') && !found.link.closest('[data-kind=tree]'))
      void prefetch(found.url).catch(() => {})
  }
  document.addEventListener('mouseover', intent, { signal })
  document.addEventListener('focusin', intent, { signal })
  const afterPaint = () =>
    requestAnimationFrame(() =>
      {
        if (signal.aborted || !mayPrefetch()) return
        // The completed Next build supplies just the four root tabs' CSS.
        // Fetch it before HTML discovery, so the first Code click has no CSS
        // network waterfall. Both shells already preload the same font bytes.
        const tabStyles =
          document.querySelector('#gild-tab-styles')?.textContent
        if (tabStyles)
          void Promise.all(
            (JSON.parse(tabStyles) as string[]).map(stylesheet),
          ).catch(() => {})
        // The entry page finishes loading first; then, while the browser is
        // idle, every repository tab warms so no first tab click waits on the
        // network. Hover/focus intent still primes anything sooner.
        const warmAll = () => {
          if (signal.aborted || !mayPrefetch()) return
          for (const link of document.querySelectorAll<HTMLAnchorElement>('nav[aria-label=Repository] a[data-tab]')) {
            const url = new URL(link.href)
            if (!link.hidden && eligible(url) && url.pathname !== displayed.pathname) void prefetch(url).catch(() => {})
          }
        }
        const idle = () => 'requestIdleCallback' in window ? window.requestIdleCallback(warmAll, { timeout: 2000 }) : setTimeout(warmAll, 300)
        if (document.readyState === 'complete') idle()
        else window.addEventListener('load', () => idle(), { once: true, signal })
      },
    )
  // Parsed markup is enough to schedule work after first paint. Waiting for
  // load serializes tab warmup behind third-party avatars and other images.
  if (document.readyState !== 'loading') afterPaint()
  else window.addEventListener('DOMContentLoaded', afterPaint, { once: true, signal })
  document.addEventListener(
    'gild:tip-changed',
    () => {
      cacheEpoch++
      cache.clear()
      loads.clear()
      bytes = 0
      clearQueue()
      attempted.clear()
      if (body()?.hasAttribute('data-navigation-pending'))
        navigate(new URL(location.href), 'restore')
    },
    { signal },
  )
  document.addEventListener(
    'gild:private-cleared',
    () => {
      generation++
      cacheEpoch++
      cache.clear()
      loads.clear()
      bytes = 0
      clearQueue()
      attempted.clear()
    },
    { signal },
  )
  signal.addEventListener(
    'abort',
    () => {
      generation++
      clearQueue()
      attempted.clear()
      options.unmount()
    },
    { once: true },
  )
  document.addEventListener(
    'gild:navigated',
    () => {
      displayed = new URL(location.href)
      renderedEpoch = cacheEpoch
      ref = readPointer(document)?.ref ?? ref
      refLinks()
      snapshot()
      schedulePrefetch()
    },
    { signal },
  )
  refLinks()
  snapshot()
  void options.mount().catch(() => {})
  return { prefetch, navigate }
}
