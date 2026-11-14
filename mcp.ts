// The MCP endpoint: Model Context Protocol over streamable HTTP, speaking
// the 2026-07-28 revision (server/discover, no session) and the legacy
// initialize handshake. The six tools act on the same store as REST, so an
// issue created here is the same object there.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Repo } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Split a full_name ("owner/repo") argument when owner/repo are absent. */
function ownerRepo(forge: Forge, args: Record<string, unknown>): { owner: string; repo: string } | undefined {
  let owner = stringArg(args, 'owner');
  let repo = stringArg(args, 'repo');
  const fullName = stringArg(args, 'full_name') ?? stringArg(args, 'fullName');
  if ((!owner || !repo) && fullName && fullName.includes('/')) {
    const [head, tail] = fullName.split('/', 2);
    owner = owner ?? head;
    repo = repo ?? tail;
  }
  if (!owner || !repo) return undefined;
  void forge;
  return { owner, repo };
}

function needRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const located = ownerRepo(forge, args);
  if (!located) throw new ToolError('owner and repo are required');
  const repo = forge.getRepo(located.owner, located.repo);
  if (!repo) throw new ToolError(`repository ${located.owner}/${located.repo} not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      if (!name) throw new ToolError('name is required');
      const repo = forge.createRepo(name, {
        description: stringArg(args, 'description') ?? '',
        isPrivate: args.private === true,
      });
      if (!repo) throw new ToolError(`repository ${name} already exists`);
      return repoJson(forge, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(forge, needRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const title = stringArg(args, 'title');
      if (!title) throw new ToolError('title is required');
      const issue = forge.createIssue(repo, { title, body: stringArg(args, 'body') ?? '' });
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const state = stringArg(args, 'state') ?? 'open';
      const issues = [...repo.items.values()]
        .filter((item) => !item.isPull)
        .filter((item) => state === 'all' || item.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue as never));
      return { issues };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (!title || !head || !base) throw new ToolError('title, head and base are required');
      const pull = forge.createPull(repo, { title, body: stringArg(args, 'body') ?? '', head, base });
      if (!pull) throw new ToolError('head or base branch does not exist');
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squash onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
      if (!item || !item.isPull) throw new ToolError(`pull request ${String(args.pull_number)} not found`);
      if (item.merged) throw new ToolError('pull request is already merged');
      const plan = forge.pullMergePlan(repo, item);
      if (plan.mergeable !== true || !plan.tree) throw new ToolError('pull request is not mergeable: conflicting changes');
      forge.squashMerge(repo, item, { tree: plan.tree });
      return pullJson(forge, repo, item);
    },
  },
];

const TOOL_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
};

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', error: { code, message }, id: id ?? null } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', result, id: id ?? null } };
}

function handleRequest(forge: Forge, request: Record<string, unknown>): McpResult | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOL_LIST);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument ${required}`);
        }
      }
      try {
        const value = tool.run(forge, args);
        const text = JSON.stringify(value);
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Answer one MCP HTTP body; null means a notification (202, no body). */
export function handleMcp(forge: Forge, rawBody: string): McpResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
    };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const result = handleRequest(forge, entry as Record<string, unknown>);
        if (result) results.push(result.body);
      }
    }
    if (!results.length) return null;
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' }, id: null },
    };
  }
  return handleRequest(forge, parsed as Record<string, unknown>);
}
