// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests with merges, shaped like GitHub's API.
// Every handler returns a status and a JSON value; app.ts writes it with the
// shared headers (request id, JSON content type).

import {
  buildCommit,
  flattenTree,
  historyFrom,
  mergeBase,
  parseCommit,
  parseTree,
  treePathOid,
  ZERO_OID,
} from './git.ts';
import type { Forge, Issue, IssueOrPull, Pull, Repo, User } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function notFound(): RestResult {
  return { status: 404, body: { message: 'Not Found' } };
}

function invalid(message: string, status = 422): RestResult {
  return { status, body: { message } };
}

// ------------------------------------------------------------------ shapes

export function userJson(user: User): Json {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.id),
    type: 'User',
    name: user.name,
    email: user.email,
    avatar_url: '',
    html_url: '',
    site_admin: false,
  };
}

/** The forge's global node id for a record: base64 of "<Type>:<database id>". */
export function globalId(type: string, databaseId: number): string {
  return Buffer.from(`${type}:${databaseId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; databaseId: number } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
    if (!match) return undefined;
    return { type: match[1] as string, databaseId: Number(match[2]) };
  } catch {
    return undefined;
  }
}

/** A stable per-item database id, unique across repositories. */
export function itemDatabaseId(repo: Repo, number: number): number {
  return repo.id * 1_000_000 + number;
}

export function repoJson(forge: Forge, repo: Repo): Json {
  void forge;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(forge.user),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.items.values()].filter((item) => item.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: '',
    url: '',
    git_url: '',
    clone_url: '',
  };
}

function labelJson(forge: Forge, repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return {
    id: repo.id * 1_000_000 + [...repo.labels.keys()].indexOf(name) + 1,
    node_id: globalId('Label', repo.id * 1_000 + [...repo.labels.keys()].indexOf(name) + 1),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: '',
  };
  void forge;
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Json {
  return {
    id: itemDatabaseId(repo, issue.number),
    node_id: globalId('Issue', itemDatabaseId(repo, issue.number)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(forge, repo, name)),
    user: userJson(issue.user),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: '',
    url: '',
    repository_url: '',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Json {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: itemDatabaseId(repo, pull.number),
    node_id: globalId('PullRequest', itemDatabaseId(repo, pull.number)),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(forge.user),
      repo: repoJson(forge, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(forge.user),
      repo: repoJson(forge, repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
    url: '',
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string; user: User; createdAt: string }): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: '',
    url: '',
  };
  void forge;
}

function commitJson(forge: Forge, oid: string): Json {
  const object = forge.objects.get(oid);
  const commit = parseCommit((object as { data: Buffer }).data);
  const splitIdent = (line: string): Json => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    node_id: oid,
    commit: {
      author: splitIdent(commit.author),
      committer: splitIdent(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(forge.user),
    committer: userJson(forge.user),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ helpers

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page, urlFor: (page: number) => string): { slice: T[]; headers: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / page.perPage));
  const links: string[] = [];
  if (page.page < lastPage) {
    links.push(`<${urlFor(page.page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page.page > 1) {
    links.push(`<${urlFor(page.page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  }
  return { slice, headers: links.length ? { Link: links.join(', ') } : {} };
}

function bodyObject(body: unknown): Json {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : {};
}

function stringField(body: Json, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ the router

export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult {
  const [head, ...rest] = segments;
  if (segments.length === 0 || (segments.length === 1 && head === '')) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
      body: {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${origin}/api/v3/repos/{owner}/{repo}/issues`,
      },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        installed_version: '1.0.0',
        git_version: 'forge-1.0',
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        hooks: [],
        pages: [],
        importer: [],
      },
    };
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson(forge.user) };
  }
  if (head === 'user' && rest[0] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = pageOf(query);
      const all = forge.listRepos().map((repo) => repoJson(forge, repo));
      const { slice, headers } = paginate(all, page, (p) => `${origin}/api/v3/user/repos?per_page=${page.perPage}&page=${p}`);
      return { status: 200, body: slice, headers };
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      const name = stringField(input, 'name');
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        return invalid('name is invalid');
      }
      const repo = forge.createRepo(name, {
        description: stringField(input, 'description') ?? '',
        isPrivate: input.private === true,
      });
      if (!repo) return invalid('name already exists on this account');
      return { status: 201, body: repoJson(forge, repo) };
    }
    return notFound();
  }
  if (head === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    if (!repo) return notFound();
    return handleRepo(forge, repo, method, segments.slice(3), query, body, origin);
  }
  return notFound();
}

function handleRepo(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: readonly string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (method === 'PATCH') {
      const input = bodyObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.name === 'string' && input.name !== repo.name) {
        const taken = forge.getRepo(repo.owner, input.name);
        if (taken) return invalid('name already exists on this account');
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = input.name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof input.default_branch === 'string') repo.defaultBranch = input.default_branch;
      repo.updatedAt = new Date().toISOString();
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }
  const [area, ...deeper] = tail;
  switch (area) {
    case 'branches':
      return handleBranches(forge, repo, method, deeper);
    case 'commits':
      return handleCommits(forge, repo, method, deeper, query);
    case 'contents':
      return handleContents(forge, repo, method, deeper, query, body);
    case 'git':
      return handleGitRefs(forge, repo, method, deeper, body);
    case 'labels':
      return handleLabels(forge, repo, method, deeper, body);
    case 'issues':
      return handleIssues(forge, repo, method, deeper, query, body, base);
    case 'pulls':
      return handlePulls(forge, repo, method, deeper, query, body);
    default:
      return notFound();
  }
}

// ------------------------------------------------------------------ branches & commits

function handleBranches(forge: Forge, repo: Repo, method: string, tail: readonly string[]): RestResult {
  if (method !== 'GET') return notFound();
  const branchJson = (name: string): Json => ({
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? ZERO_OID },
    protected: false,
  });
  if (tail.length === 0) {
    const names = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    return { status: 200, body: names.map(branchJson) };
  }
  const name = tail.join('/');
  if (!repo.refs.has(`refs/heads/${name}`)) return notFound();
  return { status: 200, body: branchJson(name) };
  void forge;
}

function handleCommits(forge: Forge, repo: Repo, method: string, tail: readonly string[], query: URLSearchParams): RestResult {
  if (method !== 'GET') return notFound();
  if (tail.length === 1) {
    const object = forge.objects.get(tail[0] as string);
    if (!object || object.type !== 'commit') return notFound();
    return { status: 200, body: commitJson(forge, tail[0] as string) };
  }
  if (tail.length !== 0) return notFound();
  const shaParam = query.get('sha') ?? repo.defaultBranch;
  const tip = forge.objects.get(shaParam)?.type === 'commit'
    ? shaParam
    : forge.branchTip(repo, shaParam);
  if (!tip) return { status: 200, body: [] };
  const page = pageOf(query);
  const history = historyFrom(forge.objects, tip);
  const { slice, headers } = paginate(history, page, (p) => `?page=${p}`);
  void headers;
  return { status: 200, body: slice.map((oid) => commitJson(forge, oid)) };
}

// ------------------------------------------------------------------ contents

function handleContents(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: readonly string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const path = tail.join('/');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const commit = forge.objects.get(ref)?.type === 'commit' ? ref : forge.branchTip(repo, ref);
    if (!commit) return notFound();
    const tree = forge.commitTree(commit);
    if (!tree) return notFound();
    if (path === '') {
      return { status: 200, body: directoryJson(forge, repo, tree, '') };
    }
    const oid = treePathOid(forge.objects, tree, path);
    if (!oid) return notFound();
    const object = forge.objects.get(oid);
    if (!object) return notFound();
    if (object.type === 'tree') {
      return { status: 200, body: directoryJson(forge, repo, oid, path) };
    }
    if (object.type !== 'blob') return notFound();
    const name = path.split('/').pop() as string;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: oid,
        size: object.data.length,
        name,
        path,
      },
    };
  }
  if (method === 'PUT') {
    if (path === '') return invalid('path is required');
    const input = bodyObject(body);
    const message = stringField(input, 'message');
    const content64 = stringField(input, 'content');
    if (message === undefined || content64 === undefined) return invalid('message and content are required');
    const branch = stringField(input, 'branch') ?? repo.defaultBranch;
    const content = Buffer.from(content64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const existing = forge.readPath(repo, branch, path);
    const givenSha = stringField(input, 'sha');
    if (existing) {
      if (givenSha !== undefined && givenSha !== existing.oid) {
        return { status: 409, body: { message: `${path} has changed since the given sha was read` } };
      }
      if (givenSha === undefined) return invalid('sha is required when updating a file');
    }
    const commit = forge.writePath(repo, branch, path, content, message);
    const blobOid = forge.objects.put('blob', content);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          type: 'file',
          encoding: 'base64',
          sha: blobOid,
          size: content.length,
          name: path.split('/').pop(),
          path,
        },
        commit: { sha: commit },
      },
    };
  }
  if (method === 'DELETE') {
    if (path === '') return invalid('path is required');
    const input = bodyObject(body);
    const message = stringField(input, 'message');
    const givenSha = stringField(input, 'sha');
    if (message === undefined || givenSha === undefined) return invalid('message and sha are required');
    const branch = stringField(input, 'branch') ?? repo.defaultBranch;
    const existing = forge.readPath(repo, branch, path);
    if (!existing) return notFound();
    if (givenSha !== existing.oid) {
      return { status: 409, body: { message: `${path} has changed since the given sha was read` } };
    }
    const commit = forge.writePath(repo, branch, path, null, message);
    return { status: 200, body: { content: null, commit: { sha: commit } } };
  }
  return notFound();
}

function directoryJson(forge: Forge, repo: Repo, treeOid: string, prefix: string): Json[] {
  void repo;
  const object = forge.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' || entry.mode === '040000' ? 0 : (forge.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

// ------------------------------------------------------------------ git refs

function handleGitRefs(forge: Forge, repo: Repo, method: string, tail: readonly string[], body: unknown): RestResult {
  if (tail[0] !== 'refs' && tail[0] !== 'ref') return notFound();
  const refPath = tail.slice(1).join('/');
  if (method === 'POST' && tail[0] === 'refs' && tail.length === 1) {
    const input = bodyObject(body);
    const ref = stringField(input, 'ref');
    const sha = stringField(input, 'sha');
    if (!ref || !sha || !ref.startsWith('refs/')) return invalid('ref and sha are required');
    if (repo.refs.has(ref)) return invalid('Reference already exists');
    const object = forge.objects.get(sha);
    if (!object) return invalid('sha does not name an object');
    repo.refs.set(ref, sha);
    repo.updatedAt = new Date().toISOString();
    return {
      status: 201,
      body: { ref, object: { sha, type: object.type } },
    };
  }
  if (method === 'GET') {
    if (refPath === '') {
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
        ref,
        object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' },
      }));
      return { status: 200, body: all };
    }
    const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
    const sha = repo.refs.get(full);
    if (!sha) return notFound();
    return { status: 200, body: { ref: full, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } } };
  }
  if (method === 'DELETE') {
    const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
    if (!repo.refs.has(full)) return notFound();
    repo.refs.delete(full);
    return { status: 204 };
  }
  return notFound();
}

// ------------------------------------------------------------------ labels

function handleLabels(forge: Forge, repo: Repo, method: string, tail: readonly string[], body: unknown): RestResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(forge, repo, name)) };
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      const name = stringField(input, 'name');
      if (!name) return invalid('name is required');
      if (repo.labels.has(name)) return invalid('Label already exists');
      repo.labels.set(name, {
        name,
        color: (stringField(input, 'color') ?? 'ededed').replace(/^#/, ''),
        description: stringField(input, 'description') ?? null,
      });
      return { status: 201, body: labelJson(forge, repo, name) };
    }
    return notFound();
  }
  const name = tail.join('/');
  if (!repo.labels.has(name)) return notFound();
  if (method === 'GET') return { status: 200, body: labelJson(forge, repo, name) };
  if (method === 'DELETE') {
    repo.labels.delete(name);
    return { status: 204 };
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function issuesOf(repo: Repo): Issue[] {
  return [...repo.items.values()].filter((item): item is Issue => !item.isPull);
}

function pullsOf(repo: Repo): Pull[] {
  return [...repo.items.values()].filter((item): item is Pull => item.isPull);
}

function sortItems<T extends IssueOrPull>(items: T[], query: URLSearchParams): T[] {
  const direction = query.get('direction') ?? 'desc';
  const sorted = [...items].sort((a, b) => a.number - b.number);
  if (direction !== 'asc') sorted.reverse();
  return sorted;
}

function handleIssues(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: readonly string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = issuesOf(repo);
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items = sortItems(items, query);
      const page = pageOf(query);
      const { slice, headers } = paginate(items, page, (p) => `${base}/issues?per_page=${page.perPage}&page=${p}`);
      return { status: 200, body: slice.map((issue) => issueJson(forge, repo, issue)), headers };
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      const title = stringField(input, 'title');
      if (!title) return invalid('title is required');
      const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : stringField(entry as Json, 'name') ?? '')).filter(Boolean) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return invalid(`Label '${label}' does not exist in this repository`);
      }
      const issue = forge.createIssue(repo, { title, body: stringField(input, 'body') ?? '', labels });
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (tail.length === 1) {
    if (!item || item.isPull) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, item) };
    if (method === 'PATCH') {
      const input = bodyObject(body);
      if (typeof input.title === 'string') item.title = input.title;
      if (typeof input.body === 'string') item.body = input.body;
      if (input.state === 'open' || input.state === 'closed') item.state = input.state;
      if (Array.isArray(input.labels)) {
        const labels = (input.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : '')).filter(Boolean);
        for (const label of labels) {
          if (!repo.labels.has(label)) return invalid(`Label '${label}' does not exist in this repository`);
        }
        item.labels = labels;
      }
      item.updatedAt = new Date().toISOString();
      return { status: 200, body: issueJson(forge, repo, item) };
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!item) return notFound();
    if (method === 'GET') {
      return { status: 200, body: item.comments.map((comment) => commentJson(forge, comment)) };
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      const text = stringField(input, 'body');
      if (text === undefined) return invalid('body is required');
      const comment = forge.addComment(item, text);
      return { status: 201, body: commentJson(forge, comment) };
    }
    return notFound();
  }
  return notFound();
}

// ------------------------------------------------------------------ pulls

function handlePulls(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: readonly string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = pullsOf(repo);
      if (state === 'open' || state === 'closed') items = items.filter((pull) => pull.state === state);
      items = sortItems(items, query);
      const page = pageOf(query);
      const { slice, headers } = paginate(items, page, (p) => `?page=${p}`);
      void headers;
      return { status: 200, body: slice.map((pull) => pullJson(forge, repo, pull)) };
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      const title = stringField(input, 'title');
      const headRaw = stringField(input, 'head');
      const baseRaw = stringField(input, 'base');
      if (!title || !headRaw || !baseRaw) return invalid('title, head and base are required');
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (!forge.branchTip(repo, head)) return invalid(`head branch '${head}' does not exist`);
      if (!forge.branchTip(repo, base)) return invalid(`base branch '${base}' does not exist`);
      const existing = pullsOf(repo).find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing) return invalid(`A pull request already exists for ${head} into ${base}`);
      const pull = forge.createPull(repo, { title, body: stringField(input, 'body') ?? '', head, base });
      if (!pull) return invalid('could not create the pull request');
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  const pull = item?.isPull ? item : undefined;
  if (tail.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    if (method === 'PATCH') {
      const input = bodyObject(body);
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if ((input.state === 'open' || input.state === 'closed') && !pull.merged) pull.state = input.state;
      pull.updatedAt = new Date().toISOString();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    return { status: 200, body: pullFiles(forge, repo, pull) };
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    if (pull.merged) return { status: 405, body: { message: 'Pull Request is already merged' } };
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not open' } };
    const plan = forge.pullMergePlan(repo, pull);
    if (plan.mergeable !== true || !plan.tree) {
      return { status: 405, body: { message: 'Pull Request is not mergeable: the head and base branches have conflicting changes' } };
    }
    const input = bodyObject(body);
    const mergeMethod = stringField(input, 'merge_method') ?? 'squash';
    let sha: string | undefined;
    if (mergeMethod === 'merge') {
      sha = trueMerge(forge, repo, pull, plan.tree);
    } else {
      sha = forge.squashMerge(repo, pull, { tree: plan.tree });
    }
    if (!sha) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    if (mergeMethod === 'merge') {
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = sha;
      pull.updatedAt = pull.mergedAt;
    }
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

/** A classic two-parent merge commit carrying the merged tree. */
function trueMerge(forge: Forge, repo: Repo, pull: Pull, tree: string): string | undefined {
  const baseSha = forge.branchTip(repo, pull.baseRef);
  const headSha = forge.branchTip(repo, pull.headRef);
  if (!baseSha || !headSha) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const who = `${forge.user.name} <${forge.user.email}> ${now} +0000`;
  const oid = forge.objects.put('commit', buildCommit({
    tree,
    parents: [baseSha, headSha],
    author: who,
    committer: who,
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  repo.updatedAt = new Date().toISOString();
  return oid;
}

/** The changed-file list of a pull: its head tree against the merge base's. */
export function pullFiles(forge: Forge, repo: Repo, pull: Pull): Json[] {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(forge.objects, baseSha, headSha) ?? baseSha;
  const baseTree = forge.commitTree(base);
  const headTree = forge.commitTree(headSha);
  if (!baseTree || !headTree) return [];
  const before = flattenTree(forge.objects, baseTree);
  const after = flattenTree(forge.objects, headTree);
  const files: Json[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid && oldEntry?.mode === newEntry?.mode) continue;
    const countLines = (oid: string | undefined): number => {
      if (!oid) return 0;
      const data = forge.objects.get(oid)?.data;
      if (!data) return 0;
      return data.toString('utf8').split('\n').length;
    };
    let status = 'modified';
    if (!oldEntry) status = 'added';
    else if (!newEntry) status = 'removed';
    const additions = newEntry ? countLines(newEntry.oid) : 0;
    const deletions = oldEntry ? countLines(oldEntry.oid) : 0;
    files.push({
      sha: newEntry?.oid ?? oldEntry?.oid ?? ZERO_OID,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}
