// Which files gild hands to cqx. One table: the filter and the "no score"
// message are both built from it, so a language can't be advertised without
// its files reaching the analysis (Java…PHP were, 8 Oct, and scored nothing).

/** Languages the bundled cqx build scores, with their source extensions. */
export const LANGUAGES = [
  { name: 'Rust', exts: ['rs'] },
  { name: 'TypeScript', exts: ['ts', 'tsx', 'mts', 'cts'] },
  { name: 'JavaScript', exts: ['js', 'jsx', 'mjs', 'cjs'] },
  { name: 'Go', exts: ['go'] },
  { name: 'Java', exts: ['java'] },
  { name: 'Kotlin', exts: ['kt', 'kts'] },
  { name: 'Swift', exts: ['swift'] },
  { name: 'Zig', exts: ['zig'] },
  { name: 'Python', exts: ['py'] },
  { name: 'PHP', exts: ['php'] },
  { name: 'C', exts: ['c', 'h'] },
  { name: 'C++', exts: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'C', 'H'] },
  { name: 'C#', exts: ['cs', 'csx'] },
] as const

/** Manifests that tell cqx what is a library, a binary or a test
 *  (cqx-layout `is_manifest`). */
const MANIFESTS = [
  'Cargo.toml', 'package.json', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'Package.swift', 'build.zig', 'pyproject.toml',
  'setup.py', 'setup.cfg', 'composer.json', 'cqx.json',
  'CMakeLists.txt', 'Makefile', 'meson.build', 'configure.ac',
]

const EXTS = new Set<string>(LANGUAGES.flatMap((l) => [...l.exts]))
const NAMES = new Set(MANIFESTS)

/** True when cqx reads this path. */
export function cqxReads(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (NAMES.has(name) || /^tsconfig[^/]*\.json$/.test(name) || name.endsWith('.csproj')) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTS.has(name.slice(dot + 1))
}

/** What to say under the bars when there is no score. */
export const UNSCORED = `No score yet: cqx reads ${LANGUAGES.slice(0, -1).map((l) => l.name).join(', ')} and ${LANGUAGES[LANGUAGES.length - 1].name}.`

/** Bumped when what gild hands to cqx changes, so scores taken with the old
 *  filter (including "nothing to score") are taken again. */
export const READS_VERSION = 'r3'

/** Selective WASM routing uses the same language/extension table as reads. */
export function moduleFor(path: string): 'core' | 'c' | 'csharp' {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const language = LANGUAGES.find(l => (l.exts as readonly string[]).includes(ext))?.name
  return language === 'C' || language === 'C++' ? 'c' : language === 'C#' ? 'csharp' : 'core'
}
