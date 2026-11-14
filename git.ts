// The git object model for the forge: SHA-1 objects (commit, tree, blob, tag),
// packfile read/write, pkt-line framing, reachability and history walks, tree
// diffs and the three-way tree merge the pull-request squash merge builds on.
// Node standard library only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The id git assigns an object: SHA-1 of "<type> <length>\0" + the raw bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ------------------------------------------------------------------ store

/** Every object the forge holds, content-addressed and shared by all repos. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store raw bytes as an object; returns its id (a no-op when already held). */
  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an already-hashed object received in a pack. */
  putKnown(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** "Name <email> 1700000000 +0000" from parts. */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** The epoch seconds inside an ident line, or 0 when unparsable. */
export function identEpoch(identLine: string): number {
  const match = /> (\d+) [+-]\d{4}$/.exec(identLine);
  return match ? Number(match[1]) : 0;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.toString('ascii', at, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree ordering: by name, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {mode, oid} for every blob (and symlink) under it. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild a tree hierarchy from a flattened path map; returns the root tree id. */
export function unflattenTree(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The blob id at `path` in a tree, or undefined. */
export function treePathOid(store: ObjectStore, treeOid: string, path: string): string | undefined {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (!tree || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) return entry.oid;
    if (!isTreeMode(entry.mode)) return undefined;
    current = entry.oid;
  }
  return undefined;
}

// ------------------------------------------------------------------ tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects to the commit they ultimately name, or undefined. */
export function peelToCommit(store: ObjectStore, oid: string): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return undefined;
    current = parseTag(object.data).object;
  }
  return undefined;
}

// ------------------------------------------------------------------ graph walks

/** Every object reachable from the given tips (commits, their trees and blobs, tags). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** All commits reachable from a tip, newest first (by committer time, then discovery). */
export function historyFrom(store: ObjectStore, tip: string): string[] {
  const commits: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    commits.push(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  commits.sort((a, b) => {
    const timeA = identEpoch(parseCommit((store.get(a) as GitObject).data).committer);
    const timeB = identEpoch(parseCommit((store.get(b) as GitObject).data).committer);
    return timeB - timeA;
  });
  return commits;
}

/** A merge base of two commits (the first common ancestor a BFS meets), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    stackA.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/**
 * What a fetch sends, computed from the wants, the haves and the shallow
 * state the client declared. The suite's dialect (checks-git.ts): a `deepen`
 * figure is the total depth wanted from the wants — a depth-1 clone followed
 * by a fetch with depth 2 delivers exactly one more generation.
 */
export interface FetchPlan {
  /** Every object id to pack, commits first. */
  objects: string[];
  /** Boundary commits for the shallow-info section (empty when not shallow). */
  shallow: string[];
  /** Client boundary commits whose history is now complete. */
  unshallow: string[];
}

/**
 * What a client already holds: everything reachable from its haves, except
 * that a commit it declares shallow is held together with its tree but its
 * parents are not — the shallow lines are exactly where its history stops.
 */
export function collectHeld(store: ObjectStore, haves: readonly string[], shallowBoundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallowBoundary.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  options: { depth?: number; clientShallow?: readonly string[] },
): FetchPlan {
  const heldObjects = collectHeld(store, haves, new Set(options.clientShallow ?? []));
  const heldCommits = new Set<string>();
  for (const oid of heldObjects) {
    if (store.get(oid)?.type === 'commit') heldCommits.add(oid);
  }
  const includedCommits: string[] = [];
  const includedSet = new Set<string>();
  const boundary = new Set<string>();

  if (options.depth !== undefined) {
    const depth = Math.max(1, Math.floor(options.depth));
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit) queue.push({ oid: commit, gen: 0 });
    }
    const visited = new Map<string, number>();
    while (queue.length) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      if (visited.has(oid) && (visited.get(oid) as number) <= gen) continue;
      visited.set(oid, gen);
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (!heldCommits.has(oid) && gen < depth) {
        if (!includedSet.has(oid)) {
          includedSet.add(oid);
          includedCommits.push(oid);
        }
        if (gen === depth - 1 && commit.parents.length) boundary.add(oid);
      }
      if (gen + 1 < depth || heldCommits.has(oid)) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  } else {
    const queue = [...wants];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = store.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      if (heldCommits.has(oid)) continue;
      if (!includedSet.has(oid)) {
        includedSet.add(oid);
        includedCommits.push(oid);
      }
      queue.push(...parseCommit(object.data).parents);
    }
  }

  // The pack: the included commits, their tree closures, and any tag objects
  // on the way to a wanted commit — nothing the client already holds.
  const pack = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (pack.has(oid) || heldObjects.has(oid)) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'tree') continue;
      pack.add(oid);
      for (const entry of parseTree(object.data)) {
        if (isTreeMode(entry.mode)) stack.push(entry.oid);
        else if (!heldObjects.has(entry.oid) && store.has(entry.oid)) pack.add(entry.oid);
      }
    }
  };
  for (const oid of includedCommits) {
    if (!heldObjects.has(oid)) pack.add(oid);
    const commit = parseCommit((store.get(oid) as GitObject).data);
    addTreeClosure(commit.tree);
  }
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = store.get(current);
      if (!object || object.type !== 'tag') break;
      if (!heldObjects.has(current)) pack.add(current);
      current = parseTag(object.data).object;
    }
  }

  const unshallow: string[] = [];
  for (const oid of options.clientShallow ?? []) {
    // A client boundary commit stops being shallow when the pack carries its
    // whole remaining ancestry (a parent chain that reaches a root).
    if (boundary.has(oid)) continue;
    const ancestors = historyFrom(store, oid);
    if (ancestors.every((ancestor) => includedSet.has(ancestor) || heldCommits.has(ancestor))) {
      const rootReached = ancestors.some((ancestor) => parseCommit((store.get(ancestor) as GitObject).data).parents.length === 0);
      if (rootReached && ancestors.length > 0) unshallow.push(oid);
    }
  }
  return { objects: [...pack], shallow: [...boundary], unshallow };
}

// ------------------------------------------------------------------ packs

/** Serialise objects into a packfile (no deltas: plain, valid, checksummed). */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (!object) continue;
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const head: number[] = [];
    let byte = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      head.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    head.push(byte);
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one object from a pack at `offset`; returns the object and the next
 * offset. Node's inflateSync tolerates trailing bytes but does not report how
 * many it consumed, so the stream's exact end is found by probing: success is
 * monotonic in the prefix length (a short prefix throws, a long one works),
 * which makes a bracket-and-bisect search exact.
 */
function inflateAt(pack: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const remaining = pack.length - offset;
  const succeeds = (length: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  let hi = Math.min(remaining, Math.max(64, expectedSize + 32));
  while (!succeeds(hi)) {
    if (hi >= remaining) throw new Error('a pack object does not inflate');
    hi = Math.min(remaining, hi * 2);
  }
  let lo = 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (succeeds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(pack.subarray(offset, offset + lo)), next: offset + lo };
}

export interface PackReadResult {
  objects: Array<{ oid: string; type: ObjectType; data: Buffer }>;
  count: number;
}

/** Parse a packfile received in a push, resolving any deltas against the store. */
export function readPack(store: ObjectStore, pack: Buffer): PackReadResult {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: Array<{ type: ObjectType; data: Buffer; oid: string }> = [];
  const byOid = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
    let at = 0;
    const readVarint = (): number => {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = delta[at] as number;
        at += 1;
        value |= (byte & 0x7f) << shift;
        shift += 7;
        if ((byte & 0x80) === 0) break;
      }
      return value;
    };
    const sourceSize = readVarint();
    if (sourceSize !== base.length) throw new Error('delta base size mismatch');
    const targetSize = readVarint();
    const out: Buffer[] = [];
    let produced = 0;
    while (at < delta.length) {
      const op = delta[at] as number;
      at += 1;
      if (op & 0x80) {
        let copyOffset = 0;
        let copySize = 0;
        if (op & 0x01) { copyOffset = delta[at] as number; at += 1; }
        if (op & 0x02) { copyOffset |= (delta[at] as number) << 8; at += 1; }
        if (op & 0x04) { copyOffset |= (delta[at] as number) << 16; at += 1; }
        if (op & 0x08) { copyOffset |= (delta[at] as number) << 24; at += 1; }
        if (op & 0x10) { copySize = delta[at] as number; at += 1; }
        if (op & 0x20) { copySize |= (delta[at] as number) << 8; at += 1; }
        if (op & 0x40) { copySize |= (delta[at] as number) << 16; at += 1; }
        if (copySize === 0) copySize = 0x10000;
        out.push(base.subarray(copyOffset, copyOffset + copySize));
        produced += copySize;
      } else if (op > 0) {
        out.push(delta.subarray(at, at + op));
        at += op;
        produced += op;
      } else {
        throw new Error('delta opcode 0');
      }
    }
    const result = Buffer.concat(out);
    if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
    return result;
  };
  const resolve = (oid: string): GitObject | undefined => byOid.get(oid) ?? store.get(oid);
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    // `size` is the inflated length, the probe hint in inflateAt.
    if (typeId === 6) {
      // OFS_DELTA: a negative offset back to the base object's start.
      let back = pack[offset] as number;
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const { data, next } = inflateAt(pack, offset, size);
      offset = next;
      const base = byOffset.get(start - baseOffset);
      if (!base) throw new Error('ofs-delta base is not in this pack');
      const resolvedData = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolvedData);
      raw.push({ oid, type: base.type, data: resolvedData });
      byOid.set(oid, { type: base.type, data: resolvedData });
      byOffset.set(start, { type: base.type, data: resolvedData });
      continue;
    }
    if (typeId === 7) {
      // REF_DELTA: the base is named by id and may be in the store already.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, next } = inflateAt(pack, offset, size);
      offset = next;
      const base = resolve(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} is not available`);
      const resolvedData = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolvedData);
      raw.push({ oid, type: base.type, data: resolvedData });
      byOid.set(oid, { type: base.type, data: resolvedData });
      byOffset.set(start, { type: base.type, data: resolvedData });
      continue;
    }
    const type = ID_TYPES[typeId];
    if (!type) throw new Error(`unknown pack object type ${typeId}`);
    const { data, next } = inflateAt(pack, offset, size);
    offset = next;
    const oid = hashObject(type, data);
    raw.push({ oid, type, data });
    byOid.set(oid, { type, data });
    byOffset.set(start, { type, data });
  }
  return { objects: raw, count };
}

// ------------------------------------------------------------------ pkt-line

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktItem = Buffer | 'flush' | 'delim' | 'response-end';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
  /** Offset just past this packet in the source buffer. */
  next: number;
}

/** Decode the pkt-line at `offset`, or null when more bytes are needed. */
export function decodePktAt(buffer: Buffer, offset: number): DecodedPkt | null {
  if (buffer.length - offset < 4) return null;
  const head = buffer.toString('ascii', offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
  const length = parseInt(head, 16);
  if (length === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 2) return { kind: 'response-end', payload: Buffer.alloc(0), next: offset + 4 };
  if (length < 4) throw new Error(`bad pkt-line length ${length}`);
  if (buffer.length - offset < length) return null;
  return { kind: 'data', payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

/** Decode every complete pkt-line in a buffer; returns the packets and the tail offset. */
export function decodePktLines(buffer: Buffer, start = 0): { packets: DecodedPkt[]; next: number } {
  const packets: DecodedPkt[] = [];
  let offset = start;
  for (;;) {
    const packet = decodePktAt(buffer, offset);
    if (!packet) break;
    packets.push(packet);
    offset = packet.next;
    if (packet.kind === 'flush') break;
  }
  return { packets, next: offset };
}

// ------------------------------------------------------------------ tree merge

export interface TreeMergeResult {
  /** The merged tree's flattened paths, when the merge is clean. */
  flat?: Map<string, { mode: string; oid: string }>;
  /** Paths both sides changed incompatibly, when it is not. */
  conflicts: string[];
}

/**
 * A file-level three-way merge of two trees against their merge base: paths
 * only one side changed take that side's version; a path both sides changed
 * to different bytes (or one side deleted while the other edited) conflicts.
 */
export function mergeTrees(
  store: ObjectStore,
  baseTree: string,
  ourTree: string,
  theirTree: string,
): TreeMergeResult {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    const oursChanged = inOurs?.oid !== inBase?.oid || inOurs?.mode !== inBase?.mode;
    const theirsChanged = inTheirs?.oid !== inBase?.oid || inTheirs?.mode !== inBase?.mode;
    if (!oursChanged && !theirsChanged) {
      if (inBase) merged.set(path, inBase);
    } else if (oursChanged && !theirsChanged) {
      if (inOurs) merged.set(path, inOurs);
    } else if (!oursChanged && theirsChanged) {
      if (inTheirs) merged.set(path, inTheirs);
    } else if (inOurs?.oid === inTheirs?.oid && inOurs?.mode === inTheirs?.mode) {
      if (inOurs) merged.set(path, inOurs);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length ? { conflicts } : { flat: merged, conflicts: [] };
}
