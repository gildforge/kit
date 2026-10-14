const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  zig: 'zig',
  py: 'python',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  css: 'css',
  html: 'html',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shellscript',
  sql: 'sql',
}
export const languageFor = (path: string) =>
  languages[path.split('.').pop()!.toLowerCase()] ?? 'text'
export const blobFragment = (hash: string, path: string, markdown = false) => ({
  kind: 'blob' as const,
  hash: `${hash}.${languageFor(path)}.${markdown ? 'readme' : 'code'}`,
})
/** Match cqx-layout's dependency/build exclusions; don't auto-download generated
 * or minified assets. They remain browsable through the per-file floor. */
export const bundlePath = (path: string) =>
  !/(^|\/)(?:vendor|node_modules|dist|build|target|\.git|\.next|generated|third_party|third-party)\//i.test(
    path,
  ) && !/\.(?:min\.[^.]+|map|lock)$/.test(path)
