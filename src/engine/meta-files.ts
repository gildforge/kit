import type { MemFS } from './memfs.js'
export const DIR='/meta'
export async function readJson<T>(fs: MemFS, path: string): Promise<T | null> {
  try {
    return JSON.parse(
      (await fs.readFile(path, { encoding: 'utf8' })) as string,
    ) as T
  } catch {
    return null
  }
}

export const writeJson = (fs: MemFS, path: string, value: unknown) =>
  fs.writeFile(path, JSON.stringify(value, null, 2) + '\n')
