// Minimal in-memory fs for isomorphic-git inside a Worker (no filesystem).
// Implements the node-style promises API isomorphic-git calls.
type Entry = string | Uint8Array

class Stats {
  dev = 0
  ino = 0
  uid = 0
  gid = 0
  mode: number
  size: number
  ctimeMs = 0
  mtimeMs = 0
  private readonly kind: 'file' | 'dir'
  constructor(kind: 'file' | 'dir', size = 0) {
    this.kind=kind
    this.mode = kind === 'dir' ? 0o40755 : 0o100644
    this.size = size
  }
  isFile() { return this.kind === 'file' }
  isDirectory() { return this.kind === 'dir' }
  isSymbolicLink() { return false }
}

export class MemFS {
  /** isomorphic-git's object cache for this clone. Pass it as `cache` on every
   *  read: without it, each object read reloads and re-indexes the packfile,
   *  which on a full-history clone is megabytes per read. */
  readonly gitCache = {}
  readonly writtenPaths = new Set<string>()
  private files = new Map<string, Entry>()
  private dirs = new Set<string>(['/'])
  private children = new Map<string,Set<string>>([['/',new Set()]])
  private link(path:string) {if(path==='/')return;const at=path.lastIndexOf('/'),parent=path.slice(0,at)||'/';let entries=this.children.get(parent);if(!entries)this.children.set(parent,entries=new Set());entries.add(path.slice(at+1))}
  private prune(path:string) {if(path==='/'||this.files.has(path)||this.dirs.has(path)||this.children.get(path)?.size)return;this.children.delete(path);const at=path.lastIndexOf('/'),parent=path.slice(0,at)||'/';this.children.get(parent)?.delete(path.slice(at+1));this.prune(parent)}

  /** Absolute, with `.`, `..`, doubled and trailing slashes resolved: git
   *  asks for paths like `/repo/.` during checkout. */
  private norm(p: string) {
    const out: string[] = []
    for (const part of p.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return `/${out.join('/')}`
  }

  get promises() { return this }

  /** A folder exists once anything is created under it, at any depth. */
  private addDirs(dir: string) {
    for (let d = dir; d && !this.dirs.has(d); d = d.slice(0, d.lastIndexOf('/')) || '/') {this.dirs.add(d);if(!this.children.has(d))this.children.set(d,new Set());this.link(d)}
  }
  async mkdir(path: string) { this.addDirs(this.norm(path)) }
  async writeFile(path: string, data: Entry) {
    const p = this.norm(path)
    this.addDirs(p.slice(0, p.lastIndexOf('/')) || '/')
    this.files.set(p, data)
    this.writtenPaths.add(p)
    this.link(p)
  }
  async readFile(path: string, opts?: { encoding?: BufferEncoding }) {
    const p = this.norm(path)
    const data = this.files.get(p)
    if (data === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    if (typeof data === 'string') return opts?.encoding ? data : new TextEncoder().encode(data)
    return opts?.encoding ? new TextDecoder().decode(data) : data
  }
  async readdir(path: string) {
    const p = this.norm(path)
    return [...(this.children.get(p)??[])]
  }
  async stat(path: string) {
    const p = this.norm(path)
    const data = this.files.get(p)
    if (data !== undefined) return new Stats('file', typeof data === 'string' ? data.length : data.byteLength)
    if (this.dirs.has(p)) return new Stats('dir')
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  }
  async lstat(path: string) { return this.stat(path) }
  async unlink(path: string) { const p=this.norm(path);this.files.delete(p);this.prune(p) }
  async rmdir(path: string) { const p=this.norm(path);this.dirs.delete(p);this.prune(p) }
  async rm(path: string) { const p=this.norm(path);this.files.delete(p);this.dirs.delete(p);this.prune(p) }
  async readlink() { throw new Error('symlinks unsupported') }
  async symlink() { throw new Error('symlinks unsupported') }
  async chmod() {}
}
