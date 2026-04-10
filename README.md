# Sultan Online (MVP Skeleton)

Multiplayer web implementation for a hidden-identity game inspired by "Sultans of Karaya".

## Chinese Quick Start

- Chinese beginner guide: [docs/quickstart-zh.md](docs/quickstart-zh.md)

## Tech Stack

- Server: Node.js + TypeScript + Socket.io + Redis (optional persistence)
- Client: React + TypeScript + Socket.io Client + Vite
- Shared contracts: TypeScript package shared between server and client

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start development (shared + server + client):

```bash
npm run dev
```

3. Open client:

```text
http://localhost:5173
```

Server runs on:

```text
http://localhost:3000
```

## Scripts

- `npm run dev`: starts shared watcher, server dev, and client dev
- `npm run typecheck`: checks all workspaces
- `npm --workspace @sultan/server run build`: build only server
- `npm --workspace @sultan/client run typecheck`: typecheck client only

## Implemented MVP Scope

- Room create/join/leave/ready/start
- Reconnect by token (`state:resync`)
- Authoritative turn-based action processing on server
- Core actions:
  - `peek`
  - `swap`
  - `swapCenter`
  - `reveal` (Sultan / Assassin / Guard / Slave / Oracle / Belly Dancer)
- Hidden information isolation:
  - face-down cards never broadcast in public state
  - private intel pushed by `game:private`
- Win conditions:
  - assassin kills sultan
  - 3 adjacent face-up slaves
  - crowned sultan survives a full round

## Redis

Redis is optional in this MVP. If `REDIS_URL` is provided, server snapshots room state to Redis:

```bash
REDIS_URL=redis://localhost:6379
```

## Project Layout

```text
apps/
  server/   # authoritative game server
  client/   # React UI
packages/
  shared/   # shared types, rules, protocol
```
