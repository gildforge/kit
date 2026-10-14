import { escapeHTML } from './context.ts'
import { digest } from './address.ts'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { LanguageInput } from 'shiki'
import light from 'shiki/themes/github-light.mjs'
import dark from 'shiki/themes/github-dark.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import jsx from 'shiki/langs/jsx.mjs'
import rust from 'shiki/langs/rust.mjs'
import go from 'shiki/langs/go.mjs'
import java from 'shiki/langs/java.mjs'
import kotlin from 'shiki/langs/kotlin.mjs'
import swift from 'shiki/langs/swift.mjs'
import zig from 'shiki/langs/zig.mjs'
import python from 'shiki/langs/python.mjs'
import php from 'shiki/langs/php.mjs'
import c from 'shiki/langs/c.mjs'
import cpp from 'shiki/langs/cpp.mjs'
import csharp from 'shiki/langs/csharp.mjs'
import css from 'shiki/langs/css.mjs'
import html from 'shiki/langs/html.mjs'
import json from 'shiki/langs/json.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import toml from 'shiki/langs/toml.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import sql from 'shiki/langs/sql.mjs'
const langs: Record<string, LanguageInput> = {
  typescript,
  tsx,
  javascript,
  jsx,
  rust,
  go,
  java,
  kotlin,
  swift,
  zig,
  python,
  php,
  c,
  cpp,
  csharp,
  css,
  html,
  json,
  markdown,
  yaml,
  toml,
  shellscript,
  sql,
}
let highlighter: ReturnType<typeof createHighlighterCore> | undefined
const loaded = new Map<string, Promise<void>>()
export const minified = (text: string) =>
  text.split('\n').some((line) => line.length > 10000)
/** Only gild-render imports this module. No highlight engine in the site. */
export async function highlight(text: string, lang: string) {
  highlighter ??= createHighlighterCore({
    themes: [light, dark],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  const h = await highlighter
  if (langs[lang] && !loaded.has(lang))
    loaded.set(lang, h.loadLanguage(langs[lang]))
  await loaded.get(lang)
  const source = text.replace(/\n$/, '')
  const result = h.codeToTokens(source, {
    lang: langs[lang] ? lang : 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  })
  // Local palette names stay short; a content-derived scope prevents collisions
  // when the router holds fragments from several files at once.
  const scope = 's' + (await digest(source + lang)).slice(0, 12)
  const palette = new Map<string, string>()
  const pair = (light: string, dark: string) => {
    const style = `--shiki-light:${light};--shiki-dark:${dark}`
    if (!palette.has(style)) palette.set(style, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[palette.size % 52] + (palette.size >= 52 ? Math.floor(palette.size / 52) : ''))
    return palette.get(style)!
  }
  const lightFG = light.colors!['editor.foreground']!
  const darkFG = dark.colors!['editor.foreground']!
  const base = pair(lightFG, darkFG)
  const runs: { name: string; content: string }[] = []
  for (const [i, tokens] of result.tokens.entries()) {
    if (i) {
      if (runs.length) runs.at(-1)!.content += '\n'
      else runs.push({ name: base, content: '\n' })
    }
    for (const token of tokens) {
      const name = /^\s+$/.test(token.content) && runs.length ? runs.at(-1)!.name : pair(String(token.htmlStyle?.['--shiki-light'] ?? lightFG), String(token.htmlStyle?.['--shiki-dark'] ?? darkFG))
      const last = runs.at(-1)
      if (last?.name === name) last.content += token.content
      else runs.push({ name, content: token.content })
    }
  }
  const body = runs.map(({ name, content }) => name === base ? escapeHTML(content) : `<i class=${name}>${escapeHTML(content)}</i>`).join('')
  const css = [...palette].map(([style, name]) => `.${scope}.${name},.${scope} .${name}{${style}}`).join('')
  return `<style>${css}</style><pre class="shiki ${scope} ${base}"><code>${body}</code></pre>`
}
