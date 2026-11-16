# core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kewrey/core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kewrey/core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process: git smart HTTP (protocol v0 and v2, pack read/write with delta resolution), the REST v3 surface, GraphQL with the same ids as REST, and an MCP server — all over one content-addressed object store, so a commit pushed over git HTTP is the same object every other surface reads. No git binary, no UI, no outside services: Node ≥ 22 standard library only, erasable TypeScript.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8gph8heq&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
