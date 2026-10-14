import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LANGUAGES, UNSCORED, cqxReads, moduleFor } from '../../dist/engine/cqx-reads.js'

// One real path per language, from the demo repos this bug hid.
const SAMPLES: Record<string, string> = {
  Rust: 'src/main.rs', TypeScript: 'source/core/Ky.ts', JavaScript: 'lib/index.mjs', Go: 'mux.go',
  Java: 'src/main/java/org/jsoup/Jsoup.java', Kotlin: 'moshi/src/main/java/com/squareup/moshi/Moshi.kt',
  Swift: 'Source/Core/Request.swift', Zig: 'src/httpz.zig', Python: 'src/requests/api.py', PHP: 'src/PHPMailer.php',
  C: 'src/cJSON.c', 'C++': 'include/x.hpp', 'C#': 'src/Polly.cs',
}

test('every advertised language reaches cqx', () => {
  for (const l of LANGUAGES) {
    assert.ok(SAMPLES[l.name], `add a sample path for ${l.name}`)
    assert.ok(cqxReads(SAMPLES[l.name]), `${l.name} files must be read`)
    assert.ok(UNSCORED.includes(l.name), `${l.name} named in the message`)
  }
})

test('C-family extensions route to their selective module, including uppercase C++', () => {
  for (const l of LANGUAGES) for (const ext of l.exts) {
    assert.ok(cqxReads(`src/example.${ext}`))
    assert.equal(moduleFor(`src/example.${ext}`), l.name === 'C' || l.name === 'C++' ? 'c' : l.name === 'C#' ? 'csharp' : 'core')
  }
})

test('manifests and config are read; everything else is not', () => {
  for (const p of ['Cargo.toml', 'a/pom.xml', 'build.gradle.kts', 'Package.swift', 'build.zig', 'pyproject.toml', 'composer.json', 'tsconfig.build.json', 'cqx.json', 'CMakeLists.txt', 'Makefile', 'meson.build', 'configure.ac', 'src/Polly.csproj'])
    assert.ok(cqxReads(p), p)
  for (const p of ['README.md', 'logo.png', '.py', 'rs'])
    assert.equal(cqxReads(p), false, p)
})
