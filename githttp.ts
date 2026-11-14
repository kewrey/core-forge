// The git smart-HTTP surface: GET info/refs advertisements (protocol v0 and
// v2), POST git-upload-pack (v2 ls-refs and fetch, v0 fetch) and POST
// git-receive-pack (v0 pushes with report-status). Repositories are created
// through REST only; a push to an unknown repository is a 404 here.

import {
  ZERO_OID,
  collectReachable,
  decodePktAt,
  encodePktLine,
  encodePktLines,
  isAncestor,
  parseTag,
  peelToCommit,
  planFetch,
  readPack,
  writePack,
} from './git.ts';
import type { Forge, Repo } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function jsonError(status: number, message: string): HttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** The refs a repository advertises, HEAD first, in git's order. */
function advertisedRefs(forge: Forge, repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = forge.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(forge.objects, oid);
      if (peeled && peeled !== oid) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function infoRefs(forge: Forge, repo: Repo | undefined, service: string, protocolVersion: number): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, `unknown service ${service}`);
  }
  if (!repo) return jsonError(404, 'Repository not found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolVersion === 2) {
    const body = encodePktLines([
      Buffer.from('version 2\n'),
      Buffer.from(`agent=${AGENT}\n`),
      Buffer.from('ls-refs=unborn\n'),
      Buffer.from('fetch=shallow\n'),
      Buffer.from('object-format=sha1\n'),
      'flush',
    ]);
    return { status: 200, contentType, body };
  }
  const preamble = encodePktLines([Buffer.from(`# service=${service}\n`), 'flush']);
  const target = headTarget(repo);
  const caps = service === 'git-upload-pack'
    ? `side-band-64k agent=${AGENT} symref=HEAD:${target}`
    : `report-status delete-refs side-band-64k agent=${AGENT}`;
  const refs = advertisedRefs(forge, repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(target) ?? ZERO_OID;
    lines.push(Buffer.from(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(Buffer.from(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) lines.push(Buffer.from(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  const body = Buffer.concat([preamble, encodePktLines([...lines, 'flush'])]);
  return { status: 200, contentType, body };
}

// ------------------------------------------------------------------ ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const targetOid = repo.refs.get(target);
  const prefixes = args.prefixes;
  const headIncluded = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headIncluded) {
    if (targetOid) {
      lines.push(Buffer.from(`${targetOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (args.unborn) {
      lines.push(Buffer.from(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else {
      lines.push(Buffer.from(`${ZERO_OID} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (prefixes.length && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(Buffer.from(`${line}\n`));
  }
  return encodePktLines([...lines, 'flush']);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

/** Sideband-frame a pack: band-1 packets of at most the pkt-line maximum. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, at + CHUNK);
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(encodePktLine(Buffer.from([1])));
  return packets;
}

function fetchResult(forge: Forge, repo: Repo, args: FetchArgs, version2: boolean): Buffer {
  const plan = planFetch(forge.objects, args.wants, args.haves, {
    depth: args.depth,
    clientShallow: args.shallow,
  });
  const pack = writePack(forge.objects, plan.objects);
  if (!version2) {
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodePktLine('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: Array<Buffer | 'flush'> = [Buffer.from('shallow-info\n')];
    for (const oid of plan.shallow) lines.push(Buffer.from(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) lines.push(Buffer.from(`unshallow ${oid}\n`));
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Parse a v2 command request: capability lines, a delim, argument lines, a flush. */
function parseV2Request(body: Buffer): { capabilities: Map<string, string>; args: string[] } {
  const capabilities = new Map<string, string>();
  const args: string[] = [];
  let offset = 0;
  let section = 0;
  while (offset < body.length) {
    const packet = decodePktAt(body, offset);
    if (!packet) break;
    offset = packet.next;
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'response-end') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      const eq = line.indexOf('=');
      if (eq === -1) capabilities.set(line, '');
      else capabilities.set(line.slice(0, eq), line.slice(eq + 1));
    } else {
      args.push(line);
    }
  }
  return { capabilities, args };
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

export function uploadPack(forge: Forge, repo: Repo | undefined, body: Buffer, protocolVersion: number): HttpResult {
  if (!repo) return jsonError(404, 'Repository not found');
  try {
    if (protocolVersion === 2) {
      const { capabilities, args } = parseV2Request(body);
      const command = capabilities.get('command');
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const line of args) {
          if (line === 'peel') lsArgs.peel = true;
          else if (line === 'symrefs') lsArgs.symrefs = true;
          else if (line === 'unborn') lsArgs.unborn = true;
          else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, lsArgs) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResult(forge, repo, parseFetchArgs(args), true) };
      }
      return jsonError(400, `unknown command ${command ?? ''}`);
    }
    // Protocol v0: want lines (the first may carry capabilities), a flush,
    // have lines, `done`, a flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let offset = 0;
    let phase = 0;
    while (offset < body.length) {
      const packet = decodePktAt(body, offset);
      if (!packet) break;
      offset = packet.next;
      if (packet.kind === 'flush') {
        phase += 1;
        if (phase >= 2) break;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: fetchResult(forge, repo, { wants, haves, shallow, depth, done: true }, false),
    };
  } catch {
    return jsonError(400, 'malformed upload-pack request');
  }
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: Repo | undefined, body: Buffer): HttpResult {
  if (!repo) return jsonError(404, 'Repository not found');
  let commands: PushCommand[] = [];
  let clientCaps = new Set<string>();
  let pack = Buffer.alloc(0);
  try {
    let offset = 0;
    for (;;) {
      const packet = decodePktAt(body, offset);
      if (!packet) throw new Error('truncated command list');
      offset = packet.next;
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        clientCaps = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0] as string));
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error(`bad ref update line ${JSON.stringify(line)}`);
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    pack = body.subarray(offset);
  } catch {
    return jsonError(400, 'malformed receive-pack request');
  }

  let unpackLine = 'unpack ok';
  if (pack.length > 0) {
    try {
      const read = readPack(forge.objects, pack);
      for (const object of read.objects) forge.objects.putKnown(object.oid, object.type, object.data);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackLine !== 'unpack ok') {
      fail('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      fail('reference is not up to date');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A deletion.
      if (command.ref === headTarget(repo)) {
        fail('deny deleting the current branch');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    const object = forge.objects.get(command.newOid);
    if (!object) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const commit = peelToCommit(forge.objects, command.newOid);
      if (!commit) {
        fail('object is not a commit');
        continue;
      }
      if (command.oldOid !== ZERO_OID && !isAncestor(forge.objects, command.oldOid, commit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  repo.updatedAt = new Date().toISOString();

  const reportLines: Array<Buffer | 'flush'> = [Buffer.from(`${unpackLine}\n`)];
  for (const result of results) {
    reportLines.push(Buffer.from(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  let responseBody: Buffer;
  if (clientCaps.has('side-band-64k')) {
    const packets = sidebandPack(report);
    responseBody = Buffer.concat([...packets, Buffer.from('0000', 'ascii')]);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Whether every object a set of tips needs is present (push completeness). */
export function storeComplete(forge: Forge, tips: readonly string[]): boolean {
  for (const oid of collectReachable(forge.objects, tips)) {
    if (!forge.objects.has(oid)) return false;
  }
  return true;
}

export { parseTag };
