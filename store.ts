// The forge's state: one object store shared by every repository, and the
// per-repository records (refs, issues, pull requests, labels, comments) the
// REST, GraphQL and MCP surfaces all read and write, so an object created on
// one surface is the same object on the others.

import {
  ObjectStore,
  buildCommit,
  flattenTree,
  ident,
  mergeBase,
  mergeTrees,
  parseCommit,
  peelToCommit,
  treePathOid,
  unflattenTree,
  ZERO_OID,
} from './git.ts';
import type { GitObject } from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The one login the suite's token names (wire.ts's seeded viewer). */
export const TOKEN_USER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  isPull: false;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  isPull: true;
}

export type IssueOrPull = Issue | Pull;

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full ref name -> object id. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  /** Issue and pull numbers share one sequence, as on GitHub. */
  items: Map<number, IssueOrPull>;
  nextNumber: number;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly user: User = TOKEN_USER;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository is visible only under its owner's login: any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.user.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | undefined {
    const key = this.repoKey(this.user.login, name);
    if (this.repos.has(key)) return undefined;
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId,
      owner: this.user.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** The commit a branch ref names, following tags, or undefined when unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return undefined;
    return peelToCommit(this.objects, oid) ?? oid;
  }

  /** The tree of a commit id (or of a branch tip when given a commit). */
  commitTree(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /**
   * Commit a new tree on a branch: parented on the branch tip when it has
   * one, parentless on an unborn branch. Returns the new commit id.
   */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const tip = this.branchTip(repo, branch);
    const now = Math.floor(Date.now() / 1000);
    const who = ident(this.user.name, this.user.email, now);
    const commit: GitObject = {
      type: 'commit',
      data: buildCommit({
        tree: treeOid,
        parents: tip ? [tip] : [],
        author: who,
        committer: who,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    };
    const oid = this.objects.put(commit.type, commit.data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = new Date().toISOString();
    return oid;
  }

  /** Set or delete one path in a branch's tree and commit it. Returns the commit id. */
  writePath(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
    const tip = this.branchTip(repo, branch);
    const flat = tip
      ? flattenTree(this.objects, (this.commitTree(tip) as string))
      : new Map<string, { mode: string; oid: string }>();
    if (content === null) {
      flat.delete(path);
    } else {
      flat.set(path, { mode: '100644', oid: this.objects.put('blob', content) });
    }
    const tree = unflattenTree(this.objects, flat);
    return this.commitOnBranch(repo, branch, tree, message);
  }

  /** The blob bytes at a path on a branch (or at a commit), or undefined. */
  readPath(repo: Repo, refOrCommit: string, path: string): { oid: string; data: Buffer } | undefined {
    const commit = this.objects.get(refOrCommit)?.type === 'commit'
      ? refOrCommit
      : this.branchTip(repo, refOrCommit);
    if (!commit) return undefined;
    const tree = this.commitTree(commit);
    if (!tree) return undefined;
    const oid = treePathOid(this.objects, tree, path);
    if (!oid) return undefined;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return undefined;
    return { oid, data: object.data };
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    const now = new Date().toISOString();
    const issue: Issue = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      user: this.user,
      createdAt: now,
      updatedAt: now,
      comments: [],
      isPull: false,
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull | undefined {
    const headSha = this.branchTip(repo, input.head);
    const baseSha = this.branchTip(repo, input.base);
    if (!headSha || !baseSha) return undefined;
    const now = new Date().toISOString();
    const pull: Pull = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: this.user,
      createdAt: now,
      updatedAt: now,
      comments: [],
      isPull: true,
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(item: IssueOrPull, body: string): Comment {
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      user: this.user,
      createdAt: new Date().toISOString(),
    };
    this.nextCommentId += 1;
    item.comments.push(comment);
    return comment;
  }

  /**
   * Whether a pull can merge cleanly, and its squash result: the head's tree
   * changes since the merge base applied onto the current base tip. A null
   * mergeable means the state cannot be told (a missing branch or history).
   */
  pullMergePlan(repo: Repo, pull: Pull): { mergeable: boolean | null; tree?: string; conflicts?: string[] } {
    const headSha = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headTree = this.commitTree(headSha);
    const baseTree = this.commitTree(baseSha);
    if (!headTree || !baseTree) return { mergeable: null };
    if (headSha === baseSha) return { mergeable: false, conflicts: [] };
    const base = mergeBase(this.objects, baseSha, headSha);
    if (!base) return { mergeable: null };
    const baseTreeOfMerge = this.commitTree(base) as string;
    const result = mergeTrees(this.objects, baseTreeOfMerge, baseTree, headTree);
    if (result.conflicts.length) return { mergeable: false, conflicts: result.conflicts };
    const tree = unflattenTree(this.objects, result.flat as Map<string, { mode: string; oid: string }>);
    return { mergeable: true, tree };
  }

  /** Squash-merge a pull onto its base branch. Returns the merge commit id. */
  squashMerge(repo: Repo, pull: Pull, plan: { tree?: string }): string | undefined {
    if (!plan.tree) return undefined;
    const baseSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const now = Math.floor(Date.now() / 1000);
    const who = ident(this.user.name, this.user.email, now);
    const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}\n`;
    const oid = this.objects.put('commit', buildCommit({
      tree: plan.tree,
      parents: [baseSha],
      author: who,
      committer: who,
      message,
    }));
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    repo.updatedAt = new Date().toISOString();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = oid;
    pull.updatedAt = pull.mergedAt;
    return oid;
  }
}

export { ZERO_OID };
