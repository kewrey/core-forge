// The GraphQL v4 endpoint: a small executor for the documents gh and the
// suite actually send — viewer and repository reads, issue/pull connections
// with cursor pagination, the create/close/merge/comment mutations, Relay
// node(id:) lookups, and __type/__schema introspection. Unknown fields are a
// 200 with an errors array naming the field, as GitHub answers.

import { pullFiles } from './rest.ts';
import { globalId, itemDatabaseId, parseGlobalId } from './rest.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end === -1 ? source.length : end) });
        at = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 4;
          } else value += esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at)) as RegExpExecArray;
      const text = match[0];
      at += text.length;
      if (text.includes('.') || /[eE]/.test(text)) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      at += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the document`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'enum' | 'null' | 'list' | 'object';
  value?: unknown;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private take(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private takeName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>();
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.takeName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        const operation: OperationNode = {
          type: keyword === 'mutation' ? 'mutation' : 'query',
          variableDefaults: new Map(),
          selectionSet: [],
        };
        if (this.peek()?.kind === 'name') operation.name = this.takeName();
        if (this.isPunct('(')) operation.variableDefaults = this.parseVariableDefinitions();
        this.skipDirectives();
        operation.selectionSet = this.parseSelectionSet();
        operations.push(operation);
      } else if (keyword === 'fragment') {
        const name = this.takeName();
        const on = this.takeName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.takeName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected keyword ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, ValueNode> {
    const defaults = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.takeName();
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.take();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
    return defaults;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.take();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.takeName();
    }
    if (this.isPunct('!')) this.take();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.take();
      this.takeName();
      if (this.isPunct('(')) {
        this.take();
        while (!this.isPunct(')')) {
          this.takeName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      if (token?.kind === 'spread') {
        this.take();
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          selections.push({ kind: 'fragmentSpread', name: this.takeName() });
        } else {
          let typeCondition: string | undefined;
          if (this.peek()?.kind === 'name') {
            this.takeName(); // 'on'
            typeCondition = this.takeName();
          }
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.takeName();
      let alias: string | undefined;
      if (this.isPunct(':')) {
        this.take();
        alias = name;
        name = this.takeName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.isPunct('(')) {
        this.take();
        while (!this.isPunct(')')) {
          const argName = this.takeName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | undefined;
      if (this.isPunct('{')) selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.take();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', value: this.takeName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.takeName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in the document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>, defaults: Map<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      const name = node.value as string;
      if (name in variables) return variables[name];
      const fallback = defaults.get(name);
      return fallback ? resolveValue(fallback, variables, defaults) : undefined;
    }
    case 'list':
      return (node.items ?? []).map((item) => resolveValue(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables, defaults);
      return out;
    }
    default:
      return node.value;
  }
}

// ------------------------------------------------------------------ schema

interface TypeRef {
  kind: 'NON_NULL' | 'LIST' | 'OBJECT' | 'SCALAR' | 'ENUM' | 'INPUT_OBJECT';
  name: string | null;
  ofType: TypeRef | null;
}

const named = (kind: TypeRef['kind'], name: string): TypeRef => ({ kind, name, ofType: null });
const nonNull = (inner: TypeRef): TypeRef => ({ kind: 'NON_NULL', name: null, ofType: inner });
const listOf = (inner: TypeRef): TypeRef => ({ kind: 'LIST', name: null, ofType: inner });
const scalar = (name: string): TypeRef => named('SCALAR', name);

interface FieldDef {
  name: string;
  type: TypeRef;
  args?: Array<{ name: string; type: TypeRef }>;
}

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'SCALAR' | 'ENUM' | 'INPUT_OBJECT';
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: Array<{ name: string; type: TypeRef }>;
}

const connectionOf = (nodeType: string): string => `${nodeType}Connection`;

function buildSchema(): Map<string, TypeDef> {
  const types = new Map<string, TypeDef>();
  const add = (def: TypeDef): void => {
    types.set(def.name, def);
  };
  for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID']) {
    add({ name, kind: 'SCALAR' });
  }
  add({ name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] });
  add({ name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] });
  add({ name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
  add({ name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
  add({ name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] });
  add({ name: 'IssueOrderField', kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
  add({ name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'] });
  add({ name: 'MergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] });
  add({ name: 'StateReason', kind: 'ENUM', enumValues: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'] });

  const pageInfo: TypeDef = {
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: nonNull(scalar('Boolean')) },
      { name: 'hasPreviousPage', type: nonNull(scalar('Boolean')) },
      { name: 'startCursor', type: scalar('String') },
      { name: 'endCursor', type: scalar('String') },
    ],
  };
  add(pageInfo);

  const connectionFields = (nodeType: string): FieldDef[] => [
    { name: 'nodes', type: listOf(named('OBJECT', nodeType)) },
    { name: 'edges', type: listOf(named('OBJECT', `${nodeType}Edge`)) },
    { name: 'pageInfo', type: nonNull(named('OBJECT', 'PageInfo')) },
    { name: 'totalCount', type: nonNull(scalar('Int')) },
  ];
  const connectionArgs: Array<{ name: string; type: TypeRef }> = [
    { name: 'first', type: scalar('Int') },
    { name: 'after', type: scalar('String') },
    { name: 'last', type: scalar('Int') },
    { name: 'before', type: scalar('String') },
  ];

  add({
    name: 'User',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'login', type: nonNull(scalar('String')) },
      { name: 'name', type: scalar('String') },
      { name: 'email', type: scalar('String') },
      { name: 'url', type: scalar('URI') },
      { name: 'avatarUrl', type: scalar('URI') },
      { name: 'createdAt', type: scalar('DateTime') },
      { name: 'updatedAt', type: scalar('DateTime') },
    ],
  });
  add({
    name: 'Ref',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: scalar('ID') },
      { name: 'name', type: nonNull(scalar('String')) },
      { name: 'prefix', type: scalar('String') },
      { name: 'target', type: named('OBJECT', 'GitObject') },
    ],
  });
  add({
    name: 'GitObject',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: scalar('ID') },
      { name: 'oid', type: nonNull(scalar('GitObjectID')) },
      { name: 'abbreviatedOid', type: scalar('String') },
    ],
  });
  add({
    name: 'Commit',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: scalar('ID') },
      { name: 'oid', type: nonNull(scalar('GitObjectID')) },
      { name: 'message', type: scalar('String') },
      { name: 'tree', type: named('OBJECT', 'Tree') },
    ],
  });
  add({
    name: 'Tree',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: scalar('ID') },
      { name: 'oid', type: nonNull(scalar('GitObjectID')) },
    ],
  });
  add({
    name: 'Label',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'name', type: nonNull(scalar('String')) },
      { name: 'color', type: scalar('String') },
      { name: 'description', type: scalar('String') },
    ],
  });
  add({
    name: 'IssueComment',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'body', type: nonNull(scalar('String')) },
      { name: 'author', type: named('OBJECT', 'User') },
      { name: 'createdAt', type: scalar('DateTime') },
      { name: 'updatedAt', type: scalar('DateTime') },
      { name: 'url', type: scalar('URI') },
    ],
  });
  const labelConnectionArgs = connectionArgs;
  add({
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'number', type: nonNull(scalar('Int')) },
      { name: 'title', type: nonNull(scalar('String')) },
      { name: 'state', type: nonNull(named('ENUM', 'IssueState')) },
      { name: 'body', type: scalar('String') },
      { name: 'url', type: scalar('URI') },
      { name: 'author', type: named('OBJECT', 'User') },
      { name: 'repository', type: named('OBJECT', 'Repository') },
      { name: 'labels', type: named('OBJECT', 'LabelConnection'), args: labelConnectionArgs },
      { name: 'comments', type: named('OBJECT', 'IssueCommentConnection'), args: connectionArgs },
      { name: 'createdAt', type: scalar('DateTime') },
      { name: 'updatedAt', type: scalar('DateTime') },
      { name: 'closedAt', type: scalar('DateTime') },
    ],
  });
  add({
    name: 'PullRequestFile',
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: nonNull(scalar('String')) },
      { name: 'additions', type: scalar('Int') },
      { name: 'deletions', type: scalar('Int') },
      { name: 'changeType', type: scalar('String') },
    ],
  });
  add({
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'number', type: nonNull(scalar('Int')) },
      { name: 'title', type: nonNull(scalar('String')) },
      { name: 'body', type: scalar('String') },
      { name: 'state', type: nonNull(named('ENUM', 'PullRequestState')) },
      { name: 'merged', type: nonNull(scalar('Boolean')) },
      { name: 'headRefName', type: nonNull(scalar('String')) },
      { name: 'baseRefName', type: nonNull(scalar('String')) },
      { name: 'headRefOid', type: scalar('GitObjectID') },
      { name: 'baseRefOid', type: scalar('GitObjectID') },
      { name: 'mergeable', type: nonNull(named('ENUM', 'MergeableState')) },
      { name: 'files', type: named('OBJECT', 'PullRequestFileConnection'), args: connectionArgs },
      { name: 'mergeCommit', type: named('OBJECT', 'Commit') },
      { name: 'author', type: named('OBJECT', 'User') },
      { name: 'repository', type: named('OBJECT', 'Repository') },
      { name: 'comments', type: named('OBJECT', 'IssueCommentConnection'), args: connectionArgs },
      { name: 'createdAt', type: scalar('DateTime') },
      { name: 'updatedAt', type: scalar('DateTime') },
      { name: 'closedAt', type: scalar('DateTime') },
      { name: 'mergedAt', type: scalar('DateTime') },
      { name: 'url', type: scalar('URI') },
    ],
  });
  add({
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: nonNull(scalar('ID')) },
      { name: 'databaseId', type: scalar('Int') },
      { name: 'name', type: nonNull(scalar('String')) },
      { name: 'nameWithOwner', type: nonNull(scalar('String')) },
      { name: 'owner', type: nonNull(named('OBJECT', 'User')) },
      { name: 'description', type: scalar('String') },
      { name: 'isPrivate', type: scalar('Boolean') },
      { name: 'defaultBranchRef', type: named('OBJECT', 'Ref') },
      { name: 'viewerPermission', type: named('ENUM', 'RepositoryPermission') },
      { name: 'hasIssuesEnabled', type: nonNull(scalar('Boolean')) },
      { name: 'hasPullRequestsEnabled', type: scalar('Boolean') },
      { name: 'issue', type: named('OBJECT', 'Issue'), args: [{ name: 'number', type: nonNull(scalar('Int')) }] },
      {
        name: 'issues',
        type: nonNull(named('OBJECT', 'IssueConnection')),
        args: [
          ...connectionArgs,
          { name: 'states', type: listOf(nonNull(named('ENUM', 'IssueState'))) },
          { name: 'orderBy', type: named('INPUT_OBJECT', 'IssueOrder') },
          { name: 'labels', type: listOf(nonNull(scalar('String'))) },
        ],
      },
      { name: 'pullRequest', type: named('OBJECT', 'PullRequest'), args: [{ name: 'number', type: nonNull(scalar('Int')) }] },
      {
        name: 'pullRequests',
        type: nonNull(named('OBJECT', 'PullRequestConnection')),
        args: [...connectionArgs, { name: 'states', type: listOf(nonNull(named('ENUM', 'PullRequestState'))) }],
      },
      { name: 'createdAt', type: scalar('DateTime') },
      { name: 'updatedAt', type: scalar('DateTime') },
      { name: 'url', type: scalar('URI') },
    ],
  });
  for (const nodeType of ['Issue', 'PullRequest', 'Label', 'IssueComment', 'PullRequestFile']) {
    add({ name: connectionOf(nodeType), kind: 'OBJECT', fields: connectionFields(nodeType) });
    add({
      name: `${nodeType}Edge`,
      kind: 'OBJECT',
      fields: [
        { name: 'node', type: named('OBJECT', nodeType) },
        { name: 'cursor', type: nonNull(scalar('String')) },
      ],
    });
  }
  add({
    name: 'IssueOrder',
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: nonNull(named('ENUM', 'IssueOrderField')) },
      { name: 'direction', type: nonNull(named('ENUM', 'OrderDirection')) },
    ],
  });
  for (const [name, fields] of Object.entries({
    CreateIssueInput: ['repositoryId', 'title', 'body', 'labelIds', 'assigneeIds', 'clientMutationId'],
    CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
    ReopenIssueInput: ['issueId', 'clientMutationId'],
    CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
    MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitTitle', 'commitBody', 'clientMutationId'],
    AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  })) {
    add({
      name,
      kind: 'INPUT_OBJECT',
      inputFields: fields.map((field) => ({
        name: field,
        type: field.endsWith('Ids') ? listOf(nonNull(scalar('ID'))) : field === 'draft' ? scalar('Boolean') : scalar('ID'),
      })),
    });
  }
  // Input field types are refined below for readability of the schema only.
  add({
    name: 'Query',
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: nonNull(named('OBJECT', 'User')) },
      {
        name: 'repository',
        type: named('OBJECT', 'Repository'),
        args: [
          { name: 'owner', type: nonNull(scalar('String')) },
          { name: 'name', type: nonNull(scalar('String')) },
        ],
      },
      { name: 'node', type: named('OBJECT', 'Node'), args: [{ name: 'id', type: nonNull(scalar('ID')) }] },
      { name: '__type', type: named('OBJECT', '__Type'), args: [{ name: 'name', type: nonNull(scalar('String')) }] },
      { name: '__schema', type: named('OBJECT', '__Schema') },
    ],
  });
  add({
    name: 'Mutation',
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: named('OBJECT', 'CreateIssuePayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'CreateIssueInput')) }] },
      { name: 'closeIssue', type: named('OBJECT', 'CloseIssuePayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'CloseIssueInput')) }] },
      { name: 'reopenIssue', type: named('OBJECT', 'ReopenIssuePayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'ReopenIssueInput')) }] },
      { name: 'createPullRequest', type: named('OBJECT', 'CreatePullRequestPayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'CreatePullRequestInput')) }] },
      { name: 'mergePullRequest', type: named('OBJECT', 'MergePullRequestPayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'MergePullRequestInput')) }] },
      { name: 'addComment', type: named('OBJECT', 'AddCommentPayload'), args: [{ name: 'input', type: nonNull(named('INPUT_OBJECT', 'AddCommentInput')) }] },
    ],
  });
  for (const [payload, inner] of Object.entries({
    CreateIssuePayload: 'issue',
    CloseIssuePayload: 'issue',
    ReopenIssuePayload: 'issue',
    CreatePullRequestPayload: 'pullRequest',
    MergePullRequestPayload: 'pullRequest',
  })) {
    add({
      name: payload,
      kind: 'OBJECT',
      fields: [
        { name: inner, type: named('OBJECT', inner === 'issue' ? 'Issue' : 'PullRequest') },
        { name: 'clientMutationId', type: scalar('String') },
      ],
    });
  }
  add({
    name: 'AddCommentPayload',
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: named('OBJECT', 'IssueCommentEdge') },
      { name: 'subject', type: named('OBJECT', 'Issue') },
      { name: 'clientMutationId', type: scalar('String') },
    ],
  });
  add({ name: 'Node', kind: 'OBJECT', fields: [{ name: 'id', type: nonNull(scalar('ID')) }] });
  return types;
}

const SCHEMA = buildSchema();

// ------------------------------------------------------------------ values

/** A value the executor walks: a tagged record the resolvers understand. */
export type GValue =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Label'; repo: Repo; name: string }
  | { __type: 'IssueComment'; repo: Repo; item: Issue | Pull; comment: { id: number; body: string; createdAt: string } }
  | { __type: 'Ref'; repo: Repo; name: string; oid: string }
  | { __type: 'Commit'; oid: string }
  | { __type: 'PullRequestFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'Connection'; items: GValue[]; totalCount: number }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'Edge'; node: GValue; cursor: string }
  | { __type: 'Payload'; fields: Record<string, unknown> }
  | { __type: '__Type'; def: TypeDef }
  | { __type: '__Field'; def: FieldDef }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__InputValue'; def: { name: string; type: TypeRef } }
  | { __type: '__Schema' }
  | { __type: 'TypeRef'; ref: TypeRef };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

/** Slice a connection's items by first/after (and last/before when given). */
function paginateConnection(items: GValue[], args: Record<string, unknown>): { __type: 'Connection'; items: GValue[]; totalCount: number; pageInfo: GValue } {
  let start = 0;
  let end = items.length;
  if (typeof args.after === 'string') {
    const index = indexFromCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  if (typeof args.before === 'string') {
    const index = indexFromCursor(args.before);
    if (index >= 0) end = Math.min(end, index);
  }
  let slice = items.slice(start, end);
  let hasNextPage = end < items.length;
  let hasPreviousPage = start > 0;
  if (typeof args.first === 'number') {
    if (slice.length > args.first) hasNextPage = true;
    slice = slice.slice(0, args.first);
  }
  if (typeof args.last === 'number') {
    if (slice.length > args.last) hasPreviousPage = true;
    slice = slice.slice(slice.length - args.last);
  }
  const firstIndex = items.indexOf(slice[0] as GValue);
  const lastIndex = items.indexOf(slice[slice.length - 1] as GValue);
  return {
    __type: 'Connection',
    items: slice,
    totalCount: items.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage,
      startCursor: slice.length ? cursorFor(firstIndex) : null,
      endCursor: slice.length ? cursorFor(lastIndex) : null,
    },
  };
}

// ------------------------------------------------------------------ resolvers

function findRepoByDatabaseId(forge: Forge, databaseId: number): Repo | undefined {
  return forge.listRepos().find((repo) => repo.id === databaseId);
}

function findItemByGlobalId(forge: Forge, id: string): { repo: Repo; item: Issue | Pull } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) return undefined;
  const repoId = Math.floor(parsed.databaseId / 1_000_000);
  const number = parsed.databaseId % 1_000_000;
  const repo = findRepoByDatabaseId(forge, repoId);
  if (!repo) return undefined;
  const item = repo.items.get(number);
  if (!item) return undefined;
  if (parsed.type === 'Issue' && item.isPull) return undefined;
  if (parsed.type === 'PullRequest' && !item.isPull) return undefined;
  return { repo, item };
}

function resolveNode(forge: Forge, id: string): GValue | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoByDatabaseId(forge, parsed.databaseId);
    return repo ? { __type: 'Repository', repo } : null;
  }
  if (parsed.type === 'User') {
    return parsed.databaseId === forge.user.id ? { __type: 'User' } : null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const found = findItemByGlobalId(forge, id);
    if (!found) return null;
    return found.item.isPull
      ? { __type: 'PullRequest', repo: found.repo, pull: found.item }
      : { __type: 'Issue', repo: found.repo, issue: found.item };
  }
  if (parsed.type === 'IssueComment') {
    for (const repo of forge.listRepos()) {
      for (const item of repo.items.values()) {
        const comment = item.comments.find((candidate) => candidate.id === parsed.databaseId);
        if (comment) return { __type: 'IssueComment', repo, item, comment };
      }
    }
    return null;
  }
  return null;
}

type Resolver = (ctx: ExecContext, source: GValue | null, args: Record<string, unknown>) => unknown;

const typeNameOf = (value: GValue): string => value.__type;

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => ({ __type: 'User' }) as GValue,
    repository: (ctx, _source, args) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? ({ __type: 'Repository', repo } as GValue) : null;
    },
    node: (ctx, _source, args) => resolveNode(ctx.forge, String(args.id ?? '')),
    __type: (_ctx, _source, args) => {
      const def = SCHEMA.get(String(args.name ?? ''));
      return def ? ({ __type: '__Type', def } as GValue) : null;
    },
    __schema: () => ({ __type: '__Schema' }) as GValue,
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.type === 'Repository' ? findRepoByDatabaseId(ctx.forge, parsed.databaseId) : undefined;
      if (!repo) throw new Error('repository not found for createIssue');
      const issue = ctx.forge.createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __type: 'Payload', fields: { issue: { __type: 'Issue', repo, issue } as GValue, clientMutationId: input.clientMutationId ?? null } } as GValue;
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findItemByGlobalId(ctx.forge, String(input.issueId ?? ''));
      if (!found || found.item.isPull) throw new Error('issue not found for closeIssue');
      found.item.state = 'closed';
      found.item.updatedAt = new Date().toISOString();
      return { __type: 'Payload', fields: { issue: { __type: 'Issue', repo: found.repo, issue: found.item } as GValue, clientMutationId: input.clientMutationId ?? null } } as GValue;
    },
    reopenIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findItemByGlobalId(ctx.forge, String(input.issueId ?? ''));
      if (!found || found.item.isPull) throw new Error('issue not found for reopenIssue');
      found.item.state = 'open';
      found.item.updatedAt = new Date().toISOString();
      return { __type: 'Payload', fields: { issue: { __type: 'Issue', repo: found.repo, issue: found.item } as GValue, clientMutationId: input.clientMutationId ?? null } } as GValue;
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.type === 'Repository' ? findRepoByDatabaseId(ctx.forge, parsed.databaseId) : undefined;
      if (!repo) throw new Error('repository not found for createPullRequest');
      const pull = ctx.forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (!pull) throw new Error('head or base branch does not exist');
      return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo, pull } as GValue, clientMutationId: input.clientMutationId ?? null } } as GValue;
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findItemByGlobalId(ctx.forge, String(input.pullRequestId ?? ''));
      if (!found || !found.item.isPull) throw new Error('pull request not found for mergePullRequest');
      const pull = found.item;
      if (pull.merged) throw new Error('pull request is already merged');
      const plan = ctx.forge.pullMergePlan(found.repo, pull);
      if (plan.mergeable !== true || !plan.tree) throw new Error('pull request is not mergeable: conflicting changes');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      if (method === 'MERGE') {
        const baseSha = ctx.forge.branchTip(found.repo, pull.baseRef) as string;
        const headSha = ctx.forge.branchTip(found.repo, pull.headRef) as string;
        const { buildCommit } = buildCommitRef();
        const now = Math.floor(Date.now() / 1000);
        const who = `${ctx.forge.user.name} <${ctx.forge.user.email}> ${now} +0000`;
        const oid = ctx.forge.objects.put('commit', buildCommit({
          tree: plan.tree,
          parents: [baseSha, headSha],
          author: who,
          committer: who,
          message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
        }));
        found.repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = new Date().toISOString();
        pull.mergeCommitSha = oid;
        pull.updatedAt = pull.mergedAt;
      } else {
        ctx.forge.squashMerge(found.repo, pull, { tree: plan.tree });
      }
      return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo: found.repo, pull } as GValue, clientMutationId: input.clientMutationId ?? null } } as GValue;
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findItemByGlobalId(ctx.forge, String(input.subjectId ?? ''));
      if (!found) throw new Error('subject not found for addComment');
      const comment = ctx.forge.addComment(found.item, String(input.body ?? ''));
      const value = { __type: 'IssueComment', repo: found.repo, item: found.item, comment } as GValue;
      return {
        __type: 'Payload',
        fields: {
          commentEdge: { __type: 'Edge', node: value, cursor: cursorFor(found.item.comments.length - 1) } as GValue,
          subject: found.item.isPull
            ? ({ __type: 'PullRequest', repo: found.repo, pull: found.item } as GValue)
            : ({ __type: 'Issue', repo: found.repo, issue: found.item } as GValue),
          clientMutationId: input.clientMutationId ?? null,
        },
      } as GValue;
    },
  },
  User: {
    id: (ctx) => globalId('User', ctx.forge.user.id),
    login: (ctx) => ctx.forge.user.login,
    name: (ctx) => ctx.forge.user.name,
    email: (ctx) => ctx.forge.user.email,
    url: () => '',
    avatarUrl: () => '',
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
  },
  Repository: {
    id: (_ctx, source) => globalId('Repository', (source as { repo: Repo }).repo.id),
    databaseId: (_ctx, source) => (source as { repo: Repo }).repo.id,
    name: (_ctx, source) => (source as { repo: Repo }).repo.name,
    nameWithOwner: (_ctx, source) => {
      const repo = (source as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => ({ __type: 'User' }) as GValue,
    description: (_ctx, source) => (source as { repo: Repo }).repo.description || null,
    isPrivate: (_ctx, source) => (source as { repo: Repo }).repo.isPrivate,
    defaultBranchRef: (ctx, source) => {
      const repo = (source as { repo: Repo }).repo;
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!oid) return null;
      return { __type: 'Ref', repo, name: repo.defaultBranch, oid } as GValue;
      void ctx;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    issue: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const item = repo.items.get(Number(args.number));
      if (!item || item.isPull) return null;
      return { __type: 'Issue', repo, issue: item } as GValue;
    },
    issues: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let items = [...repo.items.values()].filter((item): item is Issue => !item.isPull);
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states?.length) {
        items = items.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      items.sort((a, b) => {
        const byCreated = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        const primary = byCreated !== 0 ? byCreated : a.number - b.number;
        return direction === 'DESC' ? -primary : primary;
      });
      const values = items.map((issue) => ({ __type: 'Issue', repo, issue } as GValue));
      return paginateConnection(values, args);
    },
    pullRequest: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const item = repo.items.get(Number(args.number));
      if (!item || !item.isPull) return null;
      return { __type: 'PullRequest', repo, pull: item } as GValue;
    },
    pullRequests: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let items = [...repo.items.values()].filter((item): item is Pull => item.isPull);
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      items = items.filter((pull) => states.includes(pullState(pull)));
      items.sort((a, b) => b.number - a.number);
      const values = items.map((pull) => ({ __type: 'PullRequest', repo, pull } as GValue));
      return paginateConnection(values, args);
    },
    createdAt: (_ctx, source) => (source as { repo: Repo }).repo.createdAt,
    updatedAt: (_ctx, source) => (source as { repo: Repo }).repo.updatedAt,
    url: () => '',
  },
  Issue: {
    id: (_ctx, source) => {
      const value = source as { repo: Repo; issue: Issue };
      return globalId('Issue', itemDatabaseId(value.repo, value.issue.number));
    },
    number: (_ctx, source) => (source as { issue: Issue }).issue.number,
    title: (_ctx, source) => (source as { issue: Issue }).issue.title,
    state: (_ctx, source) => issueState((source as { issue: Issue }).issue),
    body: (_ctx, source) => (source as { issue: Issue }).issue.body,
    url: () => '',
    author: () => ({ __type: 'User' }) as GValue,
    repository: (_ctx, source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as GValue,
    labels: (_ctx, source, args) => {
      const value = source as { repo: Repo; issue: Issue };
      const values = value.issue.labels.map((name) => ({ __type: 'Label', repo: value.repo, name } as GValue));
      return paginateConnection(values, args);
    },
    comments: (_ctx, source, args) => {
      const value = source as { repo: Repo; issue: Issue };
      const values = value.issue.comments.map((comment) => ({ __type: 'IssueComment', repo: value.repo, item: value.issue, comment } as GValue));
      return paginateConnection(values, args);
    },
    createdAt: (_ctx, source) => (source as { issue: Issue }).issue.createdAt,
    updatedAt: (_ctx, source) => (source as { issue: Issue }).issue.updatedAt,
    closedAt: (_ctx, source) => {
      const issue = (source as { issue: Issue }).issue;
      return issue.state === 'closed' ? issue.updatedAt : null;
    },
  },
  PullRequest: {
    id: (_ctx, source) => {
      const value = source as { repo: Repo; pull: Pull };
      return globalId('PullRequest', itemDatabaseId(value.repo, value.pull.number));
    },
    number: (_ctx, source) => (source as { pull: Pull }).pull.number,
    title: (_ctx, source) => (source as { pull: Pull }).pull.title,
    body: (_ctx, source) => (source as { pull: Pull }).pull.body,
    state: (_ctx, source) => pullState((source as { pull: Pull }).pull),
    merged: (_ctx, source) => (source as { pull: Pull }).pull.merged,
    headRefName: (_ctx, source) => (source as { pull: Pull }).pull.headRef,
    baseRefName: (_ctx, source) => (source as { pull: Pull }).pull.baseRef,
    headRefOid: (ctx, source) => {
      const value = source as { repo: Repo; pull: Pull };
      return ctx.forge.branchTip(value.repo, value.pull.headRef) ?? value.pull.headSha;
    },
    baseRefOid: (ctx, source) => {
      const value = source as { repo: Repo; pull: Pull };
      return ctx.forge.branchTip(value.repo, value.pull.baseRef) ?? value.pull.baseSha;
    },
    mergeable: (ctx, source) => {
      const value = source as { repo: Repo; pull: Pull };
      if (value.pull.merged || value.pull.state === 'closed') return 'UNKNOWN';
      const plan = ctx.forge.pullMergePlan(value.repo, value.pull);
      if (plan.mergeable === true) return 'MERGEABLE';
      if (plan.mergeable === false) return 'CONFLICTING';
      return 'UNKNOWN';
    },
    files: (ctx, source, args) => {
      const value = source as { repo: Repo; pull: Pull };
      const files = pullFiles(ctx.forge, value.repo, value.pull).map((file) => ({
        __type: 'PullRequestFile',
        path: String(file.filename),
        additions: Number(file.additions),
        deletions: Number(file.deletions),
        changeType: String(file.status).toUpperCase(),
      } as GValue));
      return paginateConnection(files, args);
    },
    mergeCommit: (_ctx, source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.mergeCommitSha ? ({ __type: 'Commit', oid: pull.mergeCommitSha } as GValue) : null;
    },
    author: () => ({ __type: 'User' }) as GValue,
    repository: (_ctx, source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as GValue,
    comments: (_ctx, source, args) => {
      const value = source as { repo: Repo; pull: Pull };
      const values = value.pull.comments.map((comment) => ({ __type: 'IssueComment', repo: value.repo, item: value.pull, comment } as GValue));
      return paginateConnection(values, args);
    },
    createdAt: (_ctx, source) => (source as { pull: Pull }).pull.createdAt,
    updatedAt: (_ctx, source) => (source as { pull: Pull }).pull.updatedAt,
    closedAt: (_ctx, source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.state === 'closed' ? pull.updatedAt : null;
    },
    mergedAt: (_ctx, source) => (source as { pull: Pull }).pull.mergedAt,
    url: () => '',
  },
  Label: {
    id: (_ctx, source) => {
      const value = source as { repo: Repo; name: string };
      const index = [...value.repo.labels.keys()].indexOf(value.name);
      return globalId('Label', value.repo.id * 1_000 + index + 1);
    },
    name: (_ctx, source) => (source as { name: string }).name,
    color: (_ctx, source) => {
      const value = source as { repo: Repo; name: string };
      return value.repo.labels.get(value.name)?.color ?? 'ededed';
    },
    description: (_ctx, source) => {
      const value = source as { repo: Repo; name: string };
      return value.repo.labels.get(value.name)?.description ?? null;
    },
  },
  IssueComment: {
    id: (_ctx, source) => globalId('IssueComment', (source as { comment: { id: number } }).comment.id),
    body: (_ctx, source) => (source as { comment: { body: string } }).comment.body,
    author: () => ({ __type: 'User' }) as GValue,
    createdAt: (_ctx, source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    updatedAt: (_ctx, source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    url: () => '',
  },
  Ref: {
    id: (_ctx, source) => {
      const value = source as { name: string; oid: string };
      return `${value.name}:${value.oid}`;
    },
    name: (_ctx, source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (_ctx, source) => ({ __type: 'Commit', oid: (source as { oid: string }).oid }) as GValue,
  },
  Commit: {
    id: (_ctx, source) => (source as { oid: string }).oid,
    oid: (_ctx, source) => (source as { oid: string }).oid,
    abbreviatedOid: (_ctx, source) => (source as { oid: string }).oid.slice(0, 7),
    message: (ctx, source) => {
      const object = ctx.forge.objects.get((source as { oid: string }).oid);
      if (!object) return '';
      const split = object.data.toString('utf8').indexOf('\n\n');
      return split === -1 ? '' : object.data.toString('utf8').slice(split + 2);
    },
    tree: (ctx, source) => {
      const object = ctx.forge.objects.get((source as { oid: string }).oid);
      if (!object) return null;
      const match = /^tree ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
      return match ? ({ __type: 'Commit', oid: match[1] as string } as unknown as GValue) : null;
    },
  },
};

import { buildCommit } from './git.ts';
function buildCommitRef(): { buildCommit: typeof buildCommit } {
  return { buildCommit };
}

// Connection and payload pseudo-types resolve structurally.
function resolveStructural(ctx: ExecContext, source: GValue, field: string, args: Record<string, unknown>): unknown {
  if (source.__type === 'Connection') {
    if (field === 'nodes') return source.items;
    if (field === 'totalCount') return source.totalCount;
    if (field === 'pageInfo') return source.pageInfo;
    if (field === 'edges') {
      return source.items.map((node, index) => ({ __type: 'Edge', node, cursor: cursorFor(index) }) as GValue);
    }
  }
  if (source.__type === 'PageInfo') {
    if (field === 'hasNextPage') return source.hasNextPage;
    if (field === 'hasPreviousPage') return source.hasPreviousPage;
    if (field === 'startCursor') return source.startCursor;
    if (field === 'endCursor') return source.endCursor;
  }
  if (source.__type === 'Edge') {
    if (field === 'node') return source.node;
    if (field === 'cursor') return source.cursor;
  }
  if (source.__type === 'Payload') {
    return source.fields[field] ?? null;
  }
  if (source.__type === 'PullRequestFile') {
    if (field === 'path') return source.path;
    if (field === 'additions') return source.additions;
    if (field === 'deletions') return source.deletions;
    if (field === 'changeType') return source.changeType;
  }
  void ctx;
  void args;
  return undefined;
}

function typeRefJson(ref: TypeRef): Record<string, unknown> {
  return { kind: ref.kind, name: ref.name, ofType: ref.ofType ? typeRefJson(ref.ofType) : null };
}

function resolveIntrospection(ctx: ExecContext, source: GValue, field: string): unknown {
  if (source.__type === '__Type') {
    const def = source.def;
    switch (field) {
      case 'name': return def.name;
      case 'kind': return def.kind;
      case 'description': return null;
      case 'fields':
        return (def.fields ?? []).map((fieldDef) => ({ __type: '__Field', def: fieldDef }) as GValue);
      case 'enumValues':
        return (def.enumValues ?? []).map((name) => ({ __type: '__EnumValue', name }) as GValue);
      case 'possibleTypes': return [];
      case 'inputFields':
        return (def.inputFields ?? []).map((input) => ({ __type: '__InputValue', def: input }) as GValue);
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      default: return undefined;
    }
  }
  if (source.__type === '__Field') {
    const def = source.def;
    switch (field) {
      case 'name': return def.name;
      case 'description': return null;
      case 'args': return (def.args ?? []).map((arg) => ({ __type: '__InputValue', def: arg }) as GValue);
      case 'type': return typeRefJson(def.type);
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }
  if (source.__type === '__EnumValue') {
    if (field === 'name') return source.name;
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'deprecationReason') return null;
    return undefined;
  }
  if (source.__type === '__InputValue') {
    if (field === 'name') return source.def.name;
    if (field === 'type') return typeRefJson(source.def.type);
    if (field === 'description') return null;
    if (field === 'defaultValue') return null;
    return undefined;
  }
  if (source.__type === '__Schema') {
    if (field === 'types') return [...SCHEMA.values()].map((def) => ({ __type: '__Type', def }) as GValue);
    if (field === 'queryType') return { __type: '__Type', def: SCHEMA.get('Query') as TypeDef } as GValue;
    if (field === 'mutationType') return { __type: '__Type', def: SCHEMA.get('Mutation') as TypeDef } as GValue;
    if (field === 'subscriptionType') return null;
    if (field === 'directives') return [];
    return undefined;
  }
  if (source.__type === 'TypeRef') {
    if (field === 'kind') return source.ref.kind;
    if (field === 'name') return source.ref.name;
    if (field === 'ofType') return source.ref.ofType ? ({ __type: 'TypeRef', ref: source.ref.ofType } as GValue) : null;
    return undefined;
  }
  void ctx;
  return undefined;
}

// ------------------------------------------------------------------ execution

function schemaTypeFor(value: GValue): string {
  if (value.__type === 'Connection') return 'Connection';
  return value.__type;
}

function executeSelectionSet(
  ctx: ExecContext,
  source: GValue | null,
  typeName: string,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (!selection.typeCondition || (source && schemaTypeFor(source) === selection.typeCondition) || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(ctx, source, selection.typeCondition ?? typeName, selection.selectionSet, path));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        if (!fragment.typeCondition || (source && schemaTypeFor(source) === fragment.typeCondition)) {
          Object.assign(out, executeSelectionSet(ctx, source, fragment.typeCondition ?? typeName, fragment.selectionSet, path));
        }
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, ctx.variables, ctx.defaults);
    let value: unknown;
    let resolved = true;
    try {
      value = resolveField(ctx, source, typeName, selection.name, args);
      if (value === undefined) resolved = false;
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      value = null;
    }
    if (!resolved) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
        path: fieldPath,
      });
      value = null;
    }
    if (selection.selectionSet && value !== null && value !== undefined) {
      value = completeValue(ctx, value, selection, fieldPath);
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, selection: FieldNode, path: Array<string | number>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(ctx, entry, selection, [...path, index]));
  }
  if (typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>)) {
    const gvalue = value as GValue;
    return executeSelectionSet(ctx, gvalue, schemaTypeFor(gvalue), selection.selectionSet as SelectionNode[], path);
  }
  // A plain JSON object (an introspection type reference) walks by key.
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const sub of selection.selectionSet as SelectionNode[]) {
      if (sub.kind !== 'field') continue;
      const key = sub.alias ?? sub.name;
      const inner = record[sub.name];
      out[key] = sub.selectionSet && inner !== null && inner !== undefined
        ? completeValue(ctx, inner, sub, [...path, key])
        : (inner ?? null);
    }
    return out;
  }
  return value;
}

function resolveField(ctx: ExecContext, source: GValue | null, typeName: string, field: string, args: Record<string, unknown>): unknown {
  if (field === '__typename') {
    return source ? schemaTypeFor(source) : typeName;
  }
  if (source && (source.__type === '__Type' || source.__type === '__Field' || source.__type === '__EnumValue' || source.__type === '__InputValue' || source.__type === '__Schema' || source.__type === 'TypeRef')) {
    return resolveIntrospection(ctx, source, field);
  }
  if (source && (source.__type === 'Connection' || source.__type === 'PageInfo' || source.__type === 'Edge' || source.__type === 'Payload' || source.__type === 'PullRequestFile')) {
    const value = resolveStructural(ctx, source, field, args);
    if (value !== undefined) return value;
    // Payload fields fall through to the schema check below by type name.
    if (source.__type !== 'Payload') return undefined;
  }
  const typeResolvers = RESOLVERS[typeName] ?? (source ? RESOLVERS[schemaTypeFor(source)] : undefined);
  const resolver = typeResolvers?.[field];
  if (resolver) return resolver(ctx, source, args);
  return undefined;
}

// ------------------------------------------------------------------ entry

export interface GraphQLEnvelope {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

export async function handleGraphQL(forge: Forge, payload: unknown): Promise<GraphQLEnvelope | GraphQLEnvelope[]> {
  if (Array.isArray(payload)) {
    const results: GraphQLEnvelope[] = [];
    for (const entry of payload) results.push(await runOperation(forge, entry));
    return results;
  }
  return runOperation(forge, payload);
}

async function runOperation(forge: Forge, payload: unknown): Promise<GraphQLEnvelope> {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };
  if (typeof body.query !== 'string' || body.query === '') {
    return { errors: [{ message: 'A query document is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(body.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'The document did not parse' }] };
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((candidate) => operationName === undefined || candidate.name === operationName)
    ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: ExecContext = {
    forge,
    variables,
    defaults: operation.variableDefaults,
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const rootValue = { __type: rootType } as unknown as GValue;
  const data = executeSelectionSet(ctx, rootValue, rootType, operation.selectionSet, []);
  const envelope: GraphQLEnvelope = { data };
  if (ctx.errors.length) envelope.errors = ctx.errors;
  return envelope;
}
