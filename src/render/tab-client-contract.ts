// The interactive half of a repository page is the site's own bundle
// (tab-client.js), loaded by the router at runtime. This is the shape the
// router relies on; the site's bundle satisfies it.
export type LocalSearch = (q: string) => Promise<{ path: string; ref: string; line: number; text: string }[] | null>
export interface TabClient {
  mountTabs(container: ParentNode, clearPrivate: () => Promise<void>, local?: LocalSearch): void
  unmountTabs(): void
  prefetchTab(repository: string, tab: string, html: string): Promise<void>
}
