// Git objects and packfiles, built in the Worker so an approved `commitFiles` action can push to
// gild over smart-HTTP receive-pack. gild has no contents-write endpoint; a push is the one write
// path for files, and it goes through the same token, ACL and pre-receive checks as `git push`.
//
// Only full objects are written (no deltas), and only the objects the commit introduces: the
// changed blobs, the trees on the paths to them, and the commit. Unchanged subtrees are referenced
// by id, which receive-pack's connectivity check resolves against what the repository already has.

export type GitObjectType = "commit" | "tree" | "blob";

/** One object ready for a pack: its id and its payload without the `<type> <size>\0` header. */
export type GitObject = { oid: string; type: GitObjectType; content: Uint8Array };

/** One entry of a tree as gild's `/git/trees/{sha}` lists it, reduced to what an edit needs. */
export type TreeEntry = { name: string; mode: string; type: "blob" | "tree" | "commit"; sha: string };

/** A file change: new text content, or `null` to delete the path. */
export type FileChange = { path: string; content: string | null };

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function unhex(oid: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(bytes)));
}

/** Hashes an object the way `git hash-object -t <type>` does. */
export async function hashObject(type: GitObjectType, content: Uint8Array): Promise<GitObject> {
  const header = encoder.encode(`${type} ${content.length}\0`);
  return { oid: hex(await sha1(concat([header, content]))), type, content };
}

/**
 * Rejects paths git would refuse or that could escape the tree: absolute, empty segments, `.`,
 * `..`, `.git`, NUL or backslash.
 */
export function validatePath(path: string): string[] {
  const segments = path.split("/");
  if (path.length === 0 || path.length > 4096 || segments.some(s =>
    s === "" || s === "." || s === ".." || s.toLowerCase() === ".git" || /[\0\\]/.test(s))) {
    throw new Error(`Invalid file path ${JSON.stringify(path)}.`);
  }
  return segments;
}

// Git orders tree entries by name, comparing a subtree as if its name ended in "/".
function sortKey(entry: TreeEntry): string {
  return entry.type === "tree" ? `${entry.name}/` : entry.name;
}

function treeMode(entry: TreeEntry): string {
  // gild (like GitHub) lists trees as "040000"; the object format writes "40000".
  return entry.type === "tree" ? "40000" : entry.mode;
}

/** Encodes and hashes a tree object. */
export async function encodeTree(entries: TreeEntry[]): Promise<GitObject> {
  const sorted = entries.toSorted((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    parts.push(encoder.encode(`${treeMode(entry)} ${entry.name}\0`), unhex(entry.sha));
  }
  return hashObject("tree", concat(parts));
}

/** Who a commit is by, with a fixed timestamp so the same action always hashes the same. */
export type CommitSignature = { name: string; email: string; seconds: number };

/** Encodes and hashes a commit object. */
export async function encodeCommit(options: {
  tree: string;
  parents: string[];
  author: CommitSignature;
  message: string;
}): Promise<GitObject> {
  const who = `${options.author.name} <${options.author.email}> ${options.author.seconds} +0000`;
  const lines = [
    `tree ${options.tree}`,
    ...options.parents.map(p => `parent ${p}`),
    `author ${who}`,
    `committer ${who}`,
    "",
    options.message.endsWith("\n") ? options.message : `${options.message}\n`,
  ];
  return hashObject("commit", encoder.encode(lines.join("\n")));
}

/** Reads one tree's direct entries; `null` sha means the empty tree (a repo with no commits). */
export type TreeLoader = (sha: string) => Promise<TreeEntry[]>;

/**
 * Applies file changes to a tree and returns the new root plus every object the edit created.
 * Directories left empty by deletions are dropped, as git would never record them.
 */
export async function editTree(
  load: TreeLoader,
  baseTree: string | null,
  changes: FileChange[],
): Promise<{ root: string; objects: GitObject[] }> {
  const objects: GitObject[] = [];
  type Node = { files: Map<string, string | null>; dirs: Map<string, Node> };
  const plan: Node = { files: new Map(), dirs: new Map() };
  for (const change of changes) {
    const segments = validatePath(change.path);
    let node = plan;
    for (const dir of segments.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) node.dirs.set(dir, next = { files: new Map(), dirs: new Map() });
      node = next;
    }
    node.files.set(segments.at(-1)!, change.content);
  }

  async function build(sha: string | null, node: Node, at: string): Promise<string | null> {
    const entries = new Map<string, TreeEntry>();
    for (const entry of sha ? await load(sha) : []) entries.set(entry.name, entry);
    for (const [name, content] of node.files) {
      const existing = entries.get(name);
      if (existing?.type === "tree") throw new Error(`${at}${name} is a directory, not a file.`);
      if (content === null) {
        if (!existing) throw new Error(`Cannot delete ${at}${name}: it does not exist.`);
        entries.delete(name);
        continue;
      }
      const blob = await hashObject("blob", encoder.encode(content));
      objects.push(blob);
      entries.set(name, { name, mode: existing?.mode ?? "100644", type: "blob", sha: blob.oid });
    }
    for (const [name, child] of node.dirs) {
      const existing = entries.get(name);
      if (existing && existing.type !== "tree") throw new Error(`${at}${name} is a file, not a directory.`);
      const built = await build(existing?.sha ?? null, child, `${at}${name}/`);
      if (built === null) entries.delete(name);
      else entries.set(name, { name, mode: "40000", type: "tree", sha: built });
    }
    if (entries.size === 0 && at !== "") return null;
    const tree = await encodeTree([...entries.values()]);
    objects.push(tree);
    return tree.oid;
  }

  const root = (await build(baseTree, plan, ""))!;
  return { root, objects };
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream("deflate") is the zlib (RFC 1950) format a pack entry carries.
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Builds a version-2 packfile of full (undeltified) objects, deduplicated by id. */
export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const unique = [...new Map(objects.map(o => [o.oid, o])).values()];
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, unique.length);
  const parts: Uint8Array[] = [header];
  for (const object of unique) {
    let size = object.content.length;
    const head: number[] = [(TYPE_CODES[object.type] << 4) | (size & 0x0f)];
    size >>>= 4;
    while (size > 0) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
      size >>>= 7;
    }
    parts.push(new Uint8Array(head), await deflate(object.content));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}
