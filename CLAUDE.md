# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**Read `PROJECT.md` too.** It describes what this project *is*, its stack, and tracks every feature's status. This file is only about *how to work here*.

---

## 1. Rules

### 1.1 Ask when uncertain
If you are unsure about requirements, intent, scope, or an unfamiliar API — **ask**. Never guess and never quietly pick an interpretation. One clarifying question is cheaper than a wrong implementation.

### 1.2 Verify against docs, not memory — every time
Before writing code against *any* library, framework or CLI, read that tool's docs **for the version pinned in this repo**. Every time, including for things you are confident you know. Training data goes stale and this repo runs deliberately recent versions.
- Discord.js v14 → `node_modules/discord.js/` or context
- Tailwind v4 → check `node_modules/tailwindcss/`
- React 19 → check `node_modules/react/`
- Express 5 → check `node_modules/express/`
Check the installed version first: `node -p "require('<pkg>/package.json').version"`

### 1.3 Build and lint before claiming anything works
After finishing a self-contained piece of work — not after every file edit:
```bash
npm run build   # must succeed (builds both UI and optionally server)
npm run lint    # oxlint must be clean
```
Only once both pass may you describe the work as done, working, or implemented. If either fails, fix it or report the failure with its output — never round a failure up to success.

### 1.4 No git operations unless explicitly told
Never branch, stage, commit, push, tag, merge or release on your own initiative. Wait for a direct instruction naming the operation.

### 1.5 Follow the stack's conventions
Use Vite, Express, Discord.js, Tailwind v4 and shadcn the way those projects intend. Prefer built-in mechanisms over hand-rolled ones. If you find yourself fighting a convention, that is a signal to stop and ask.
- **shadcn/ui**: Do not hand-write components that shadcn already provides. Use `npx shadcn@latest add <component>`.
- **Bot logic**: Separate Discord event handlers from AI logic and Database logic.

### 1.6 Keep PROJECT.md current
Create and maintain a `PROJECT.md` carrying the feature register. Whenever a feature is requested, started, finished or abandoned, update its row in the same change:
`TODO` → `PLAN` → `WIP` → `IMPL`

### 1.7 Delegate small, well-defined work to subagents
When the thinking is done and what remains is a small, mechanical, clearly specified change, hand the implementation to a subagent on a cheaper model (if available) rather than doing it inline. Keep design decisions and cross-cutting refactors for yourself.

### 1.8 Design for modularity and plugins
Build so the next feature or plugin slots in without a restructure. Concretely:
- The bot must have a robust plugin architecture with hooks (`onMessage`, `onHourlyCheck`, `beforeReply`, etc.).
- Admin API should be cleanly separated from Discord bot logic, though they share the same DB instances.

---

## 2. Where code goes

This is a monolithic repository holding both a Vite-based React frontend (Admin UI) and a Node.js Express + Discord.js backend.

| Folder | Holds |
|--------|-------|
| `src/client/` | Vite/React frontend for the admin panel. |
| `src/server/` | Node.js backend (Express + Discord bot + AI logic). |
| `src/server/bot/` | Discord.js setup, commands, and event listeners. |
| `src/server/ai/` | OpenRouter API calls, prompt building, and embeddings. |
| `src/server/db/` | SQLite models (users, stats, settings) and ChromaDB client for vector facts. |
| `src/server/plugins/` | The plugin system engine and user-installed plugins. |
| `src/server/api/` | Express routes serving the admin panel. |
| `src/shared/` | Types and constants shared between client and server. |

*Note: You may need to create or reorganize into these folders if they don't exist yet.*

### 2.1 Backend Separation
The bot, the Express API, and the Plugin engine all run in the same Node process (`src/server/index.ts`), but their concerns must be kept strictly separated in folders.

### 2.2 Database split
- **SQLite**: Stores simple relational data: Admin user credentials, system settings (hourly check interval, max reply history length), plugin statuses, and high-level stats (reply count).
- **ChromaDB**: Stores the facts (vector embeddings) along with rich metadata (channel ID, message IDs, time periods, references to other facts).

### 2.3 Plugin System
Plugins live in `src/server/plugins/`. A `PLUGINS.md` file must be created to document how to build and install a plugin. Plugins must be manageable via the Admin UI (enable/disable/configure).

---

## 3. Things that will surprise you

- **Tailwind v4 has no `tailwind.config.*`** — config lives directly in CSS.
- **Express 5** is used, which has built-in Promise handling for async routes (no need for `express-async-errors` or try/catch wrappers in routes).
- **Discord.js v14** requires specific Gateway Intents to read message content (`GatewayIntentBits.MessageContent`).
- **Every model call goes through OpenRouter**, using the `openai` package pointed at `https://openrouter.ai/api/v1`. There is no second provider.
- **Monorepo setup**: `npm run dev` starts both Vite (`dev:ui`) and the Node server (`dev:server`) via `concurrently`.

---

## 4. Commands

```bash
npm run dev        # Starts both UI and Server
npm run dev:ui     # Vite dev server
npm run dev:server # Nodemon for backend
npm run build      # Builds UI and TypeScript
npm run lint       # oxlint
```

**shadcn components**:
```bash
npx shadcn@latest add <component>
```
