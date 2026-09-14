# Writing Big Yahu plugins

Big Yahu has two pipelines: a periodic one that reads channels and turns messages into
facts, and a reply pipeline that fires when someone mentions the bot. Plugins hook into
both without touching their code, and can also lend the bot tools the model can call,
add screens to the admin panel, and keep their own state. This document describes the
plugin API as it exists today. Read it alongside the source, which is the actual
authority:

- `packages/plugin-sdk/src/` — the contract itself, published as
  `@big-yahu/plugin-sdk`: `BigYahuPlugin`, `PluginContext`, `PluginTool`,
  `PluginToolContext`, `PluginToolInvocation`, `PluginPanel`, `PluginPage`,
  `PanelElement`, the hook contexts, `DraftPrompt`, and `PLUGIN_API_VERSION`. This is
  the package you depend on, so it is also the thing to read.
- `src/server/plugins/manifest.ts` — what a package must contain, how identity is
  resolved, and `linkNodeModules`.
- `src/server/plugins/installer.ts` — git and zip install, subfolder detection,
  dependency installation, uninstall.
- `src/server/plugins/engine.ts` — discovery, load order, hot reload, error isolation,
  tools, instructions, and panel rendering.
- `src/server/plugins/database.ts` — the per-plugin SQLite file.
- `src/server/plugins/secrets.ts` and `src/server/db/repositories/pluginEnvRepo.ts` —
  secret encryption and validation.
- `src/server/db/repositories/pluginStorageRepo.ts` — the scoped key/value store.
- `src/server/api/routes/plugins.ts` — the management endpoints behind the admin panel.
- `src/server/plugins/bundled/` — the three shipped plugins: `reputation`,
  `rolling-memory`, and the controller-only `discord-admin` tool suite.

---

## 1. What a plugin is

A plugin is an ordinary Node package: a `package.json` plus an entry file whose
**default export** carries the plugin's capabilities. There is no separate manifest
format and no registration step — `package.json` *is* the manifest.

An export is valid if it has **any** of a hook, a tool, a panel, a page, or
`instructions` — a tools-only or page-only plugin with no hooks at all is normal and
expected.

Identity comes from npm fields, with an optional `bigYahu` block to override them
without disturbing anything npm itself cares about:

| Manifest field | Resolved from |
|---|---|
| `id` | `bigYahu.id` → `bigYahu.name` → `name`, stripped of a `@scope/` prefix and lowercased. Must match `^[a-z0-9][a-z0-9-]{1,63}$`. |
| `name` (display) | `bigYahu.displayName` → `bigYahu.name` → `name` → falls back to `id`. |
| `description` | `bigYahu.description` → `description`. |
| `version` | `bigYahu.version` → `version` → `'0.0.0'`. |
| `main` | `bigYahu.main` → `main` → `'index.js'`. Must exist inside the package and must not resolve outside it. |
| `apiVersion` | The major of your `@big-yahu/plugin-sdk` dependency, falling back to `bigYahu.apiVersion`. **Required.** See below. |

### The API version

```json
{ "devDependencies": { "@big-yahu/plugin-sdk": "^4" } }
```

**Depending on the SDK is how you declare the contract version.** Its major version *is*
the contract version, so the range you already maintain says it and there is no second
field to keep in step — `npm update` is the whole of keeping your declaration current.

It is read out of your `package.json` rather than from your imports, because the check
happens *before* your entry file is imported: a plugin written against a contract the host
does not speak may do anything at import time, and running its top level to find out it
should not have run is the wrong order.

A plugin that does not use the SDK — plain JavaScript, no build step, nothing to typecheck
— says it directly instead:

```json
{ "bigYahu": { "displayName": "My Plugin", "apiVersion": 4 } }
```

Do not do both. When the two disagree the plugin is refused rather than one being quietly
preferred: silently picking a winner would hide exactly the drift this is here to prevent.
A `github:` or tag dependency carries no version number and cannot be read, so pair that
with the explicit field.

It has to match **exactly**: not "the same major", because the thing being prevented is a
plugin running against a contract it does not understand, and a partial match is precisely
the fuzzy version of that. The current version is `PLUGIN_API_VERSION`, exported by the
SDK and imported by the bot, so the two cannot disagree.

**API v3 is intentionally incompatible with external v2 plugins.** They remain installed
and visible but are marked incompatible and are not imported. To migrate, update the
dependency to `@big-yahu/plugin-sdk` `^4` (or the explicit `bigYahu.apiVersion` to `4` for
SDK-less JavaScript) and update every tool handler's second parameter from
`PluginContext` to `PluginToolContext`. The ordinary plugin services are still there;
tool handlers now also receive the authoritative `ctx.invocation` described in section 5.

A plugin that declares nothing, or declares the wrong number, is **not an error and not
hidden**. It installs, it is listed in the panel, and it is marked incompatible with the
reason — but it never runs: its entry file is not even imported, because a plugin written
against another contract may do anything at import time and running its top level to find
out it should not have run is the wrong order. It has no hooks, no tools, no panels and no
pages, and it cannot be switched on.

Listing it rather than hiding it is deliberate. A plugin that silently vanished from the
panel after a bot update reads as the panel being broken, not the plugin.

The version is bumped whenever anything a plugin depends on changes shape — a hook's
arguments, what a tool handler is handed, what a page must return.

`package.json` wins over whatever the default export sets for `id`/`name`/`description`/
`version` — the engine overwrites those four fields on the loaded plugin object right
after import, so a mismatch between the two is silently corrected in favour of the
manifest.

Minimal complete `package.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What it does, in one line.",
  "main": "index.ts",
  "type": "module",
  "bigYahu": {
    "displayName": "My Plugin"
  },
  "devDependencies": {
    "@big-yahu/plugin-sdk": "^4"
  }
}
```

`type: module` is required if the entry file uses `import`/`export` syntax, since it is
loaded with a dynamic `import()`. The entry file itself:

```ts
import { definePlugin } from '@big-yahu/plugin-sdk';

export default definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'What it does, in one line.',
  version: '1.0.0',

  onMessage({ message }) {
    // ...
  },
});
```

```bash
npm install --save-dev @big-yahu/plugin-sdk
```

A **devDependency**. Everything in the SDK except `PLUGIN_API_VERSION`, `HOOK_NAMES` and
`definePlugin` is a type, so nothing of it exists at runtime and a production install
never fetches it. `definePlugin` is identity at runtime — it exists so a mistyped hook or
a handler with the wrong argument is a red squiggle rather than a plugin the bot silently
declines to register because the structural check recognised nothing.

Earlier versions of this guide told you to `import type { BigYahuPlugin } from
'../../types'`. That was right for a bundled plugin and wrong for an installed one: from
`<plugins dir>/<id>/index.ts` it resolves to `<plugins dir>/types`, which does not exist.
It appeared to work only because `import type` is erased before Node sees it, so the
plugin ran while `tsc` and your editor both broke.

`defaultConfig` seeds the plugin's saved state row the first time it is discovered
(`INSERT ... ON CONFLICT DO NOTHING`). Once seeded, whatever an operator has since changed
in the admin panel always wins; bumping `defaultConfig` in a later version does not affect
an existing install, which is why `withDefaults`-style merging at read time is not
optional.

**Every plugin starts disabled, and a plugin cannot change that.** There is no
`enabledByDefault`: installing a plugin means running its author's code as the bot, and a
plugin able to switch itself on would be making that decision for the operator — including
on an update, where nobody went looking for a new switch. Somebody turns it on in the
panel, or it does not run.

---

## 2. Installing

Plugins are installed from the admin panel's Plugins page, two ways:

- **A git URL** — `https://...` only. Cloned with `git clone --depth 1 --single-branch`,
  a 60-second timeout, and credential prompting disabled, so a private repo fails fast
  instead of hanging.
- **A `.zip` upload** — capped at 10 MB, kept in memory until it has been unpacked into
  scratch space and validated as a real package. A bad upload never touches disk as a
  plugin.

Either way, the source can be **the package itself or a repo/archive containing it in a
subfolder** — the installer looks for `package.json` at the top level first, then one
level down, and installs from wherever it finds one. That is what lets you point it at a
whole repo whose plugin lives in `packages/my-plugin/`.

Installed plugins are copied into the plugins directory — resolved as `<directory of the
SQLite file>/plugins`, **beside the database, not inside the source tree**, so they
survive an image rebuild or a fresh `git pull` of the bot itself. (`.git`, if present, is
stripped from the copy.) The three bundled plugins live separately under
`src/server/plugins/bundled/` and ship with the bot's own source.

**Installing over an id that already exists is an update, not a clash.** The old
directory is replaced and nothing else is touched, because the directory holds only the
plugin's code: its database lives beside the bot's under `plugin-data/`, and its config,
secrets and storage are rows in the bot's own tables. So an update keeps everything the
operator configured and everything the plugin recorded. Uninstalling is the thing that
throws data away, and updating is deliberately not that.

Either install endpoint reloads the whole plugin registry immediately afterwards —
**installing takes effect right away, no bot restart** — and the reload happens after the
files are in place, so an update never runs the old code against the new migrations. The
response says whether it was an install or an update.

### Dependencies

**A plugin is installed as production.** Everything it needs at runtime goes in
`dependencies`; the SDK, `typescript` and `@types/*` go in `devDependencies`. That is the
whole rule.

If `dependencies` is non-empty they are installed into the plugin's own `node_modules`
right after it is copied into place — `--omit=dev --ignore-scripts --no-audit --no-fund`,
with a 5-minute timeout. `npm ci` is used when you committed a `package-lock.json`, so two
operators installing on different days get the same tree, and `npm install` when you did
not. Lifecycle scripts are skipped deliberately: a plugin that has been installed but
never enabled should not have executed anything (its own code still runs once enabled —
this only bounds *when* installation-time scripts could run, which is never). Most native
modules are unaffected, since anything shipping prebuilds does not need a script; one that
genuinely has to compile will fail, and will now say so in the panel rather than
disappearing.

If you ship an archive rather than a repository, its `node_modules` is stripped before
install. Otherwise the plugin would run on whatever was on your laptop, devDependencies
and all, and its declared dependencies would never be installed at all.

**You may depend on a library the bot also uses, and get your own copy.** That is safe
here, and the reason is worth stating because it constrains the API rather than your
plugin: *nothing on the plugin boundary uses `instanceof`, and no host function is ever
handed a library object your plugin constructed.* Everything you are given is a
host-built object you read from or call methods on, and everything you return is checked
structurally. So your own `drizzle-orm` builds a self-contained graph over the
`ctx.database` handle by duck-typing, and your own `discord.js` reads `message.content`
and calls `message.reply()` on the host's object perfectly happily. The cost of a second
copy is disk and memory, not correctness.

The same applies to a *transitive* copy you never asked for — a dependency of a dependency
pulling in its own version of something the bot also has. It is not policed, because it
does not need to be.

Separately, the bot's own `node_modules` is symlinked in beside the plugins directory at
load time, so a plugin **may** import what the bot already ships — `drizzle-orm`,
`better-sqlite3`, `discord.js` — without declaring it. That is a convenience, not the
mechanism: prefer declaring what you use, and take the shared copy only when you
deliberately want the bot's exact version.

### Other management operations

All under `/api/plugins`:

- `DELETE /:id` — uninstall one plugin, and delete its secrets, storage, and SQLite
  database. Bundled plugins cannot be uninstalled this way.
- `DELETE /` — uninstall everything installed (not the bundled ones), cleaning up the
  same per-plugin state for each.
- `POST /reload` — re-run discovery without installing or removing anything — useful
  after editing a plugin's files on disk directly. A plugin that throws while being
  imported — a missing dependency, a native binding that never built, a syntax error — is
  listed in the panel with the error rather than vanishing.
- `PATCH /:id` — flip `enabled`, or save `config`. With a `configSchema` the values are
  coerced against it and a required field left empty is rejected with a message; without
  one the object replaces what is stored, wholesale rather than merged.
- `GET /:id/pages` and `GET /:id/pages/:pageId?page=&pageSize=&query=` — list a plugin's
  pages, and render one. `POST /:id/pages/:pageId/actions/:actionId` with `{ rowId }` runs
  a row button.
- `GET /:id/env/keys` — which secrets are set, without their values.
  `GET|PUT /:id/env` reads and writes them and needs an elevated session.
  `DELETE /:id/env/:key` removes one, and refuses for a secret the plugin declared.

---

## 3. The six hooks

All hook contexts extend `PluginContext` (section 9). Hooks for **disabled plugins are
never invoked** — the registry is filtered by the saved `enabled` flag before any hook
runs, so a disabled plugin's code does not execute at all, not even to check whether it
wants to act.

A channel with replying disabled is filtered out in `messageCreate.ts` **before**
`onMessage` is even called — nothing runs for a channel the bot may not write in, plugin
hooks included, so nothing can post there by another route.

### `onMessage`

```ts
export interface OnMessageContext extends PluginContext {
  message: Message;
}
onMessage?(ctx: OnMessageContext): Promise<void> | void;
```

Fires once for **every** non-bot message in the served guild's channels the bot may
reply in — including messages that go on to mention the bot. In
`src/server/bot/events/messageCreate.ts`, `handleMessage` returns early for bot authors,
DMs, an unserved guild, and a channel with replying disabled, then calls
`runOnMessage({ message })` unconditionally, and only *afterwards* checks whether the
message addresses the bot. So `onMessage` always runs first, regardless of whether a
reply follows.

Good for lightweight, per-message logic that does not need the reply pipeline — keyword
watching, canned replies, logging, moderation signals. A plugin in this shape would scan
`message.content` for trigger phrases and reply directly with `message.reply(...)`,
without spending a model call. Rolling memory uses this hook to age its records;
reputation and Discord Admin do not.

### `onHourlyCheck`

```ts
export interface OnHourlyCheckContext extends PluginContext {
  channelId: string;
  guildId: string;
  newMessages: Message[];
}
onHourlyCheck?(ctx: OnHourlyCheckContext): Promise<void> | void;
```

Fires once per channel, per periodic extraction pass, from `runExtractionForChannel` in
`src/server/ai/factExtraction.ts`. It runs **after** new messages since the channel's
checkpoint have been fetched but **before** they are cached into `cached_messages` and
before the fact-extraction model call is made. `newMessages` is that batch, oldest
first, already filtered to non-bot messages with non-empty content. If there is nothing
new for the channel, the checkpoint is advanced and `onHourlyCheck` is not called at all
for that pass.

Good for side channels of the same batch fact extraction consumes — custom logging,
mirroring activity elsewhere, alerting on channel activity. It observes the batch; it
cannot change what gets extracted from it.

### `onBotTagged`

```ts
export interface OnBotTaggedContext extends PluginContext {
  message: Message;
}
onBotTagged?(ctx: OnBotTaggedContext): Promise<void> | void;
```

Fires in `messageCreate.ts` right after the "is this addressed to the bot" check passes
(a direct @mention, or a reply to one of the bot's own messages) and **before**
`handleMention` — the function that runs topic extraction, fact retrieval, and reply
generation — is called. At this point a reply is certainly about to be attempted, but
nothing about it exists yet: no topic extracted, no facts retrieved, no draft prompt
built.

Good for metrics on how often or where the bot gets tagged, logging — anything that
wants to know "a reply is about to be attempted" without touching its content. To affect
or veto the reply itself, use `beforeReply` — `onBotTagged` cannot change or stop what
follows.

### `annotateContext`

```ts
export interface AnnotateContextContext extends PluginContext {
  taggedMessage: Message;
  users: ContextUser[];
  messages: ContextMessageRef[];
  facts: Fact[];
}
annotateContext?(
  ctx: AnnotateContextContext,
): Promise<ContextAnnotations | void> | ContextAnnotations | void;
```

Fires from `handleMention` in `src/server/bot/replyPipeline.ts`, while the reply prompt
is being assembled and **before** `beforeReply` runs. `users` is everyone in play — every
author in the message window, plus anyone only named in a recalled fact — `messages` is
the window the reply is being written against, and `facts` are the facts already
retrieved from ChromaDB for this reply. A plugin returns `ContextAnnotations`: optional
`users`, `facts` and `messages` maps keyed by id, plus a free-form `notes` string. Each
keyed line is rendered in the prompt beside the person, fact or message it is about, so
the model sees it as something it already knows rather than something it has to call a
tool to find out.

Unlike `beforeReply`, `annotateContext` is **not chained** — every plugin that implements
it is asked independently, off the same unmodified `payload`, and none of them sees
another's answer. If two plugins annotate the same person, both annotations appear.

This hook is reply-only: the periodic fact-extraction pass never calls it, so nothing a
plugin contributes here can end up embedded in a stored fact. `collectAnnotations` wraps
everything it renders in an instruction telling the model to act on it but never read it
out, quote it, or say what it says — so a private read on someone, such as a reputation
score, shapes the reply without becoming text in it. That is the reason this exists as
its own hook rather than a plugin simply splicing the same note into `systemInstruction`
from `beforeReply`: doing it there would mean re-deriving that "never repeat this" framing
by hand, and a slip would let the note leak into the visible reply — which is itself a new
message the next extraction pass reads, and could turn straight back into a stored fact.

A plugin that throws out of `annotateContext` is logged and skipped, the same as any
other hook — the reply still goes out, just without that plugin's annotations.

### `annotateExtraction`

```ts
annotateExtraction?(ctx: AnnotateExtractionContext): Promise<string | void> | string | void;

export interface AnnotateExtractionContext extends PluginContext {
  channelId: string;
  guildId: string;
  messages: ContextMessageRef[];
}
```

The extraction pass's counterpart to `annotateContext`, and deliberately **not** a
rename of it. Return free text — background the model should have while it works out
what is worth remembering, such as who "he" is or what "the thing" refers to. There is
no per-user or per-fact rendering to hang keyed lines on here, and what a plugin has to
say about a whole window does not fit a key.

**Read this before implementing it.** Everything said through `annotateContext` is
reply-only, and the guarantee that buys — that nothing a plugin contributes can be
embedded in a permanent fact — is what `reputation` is written against. Reaching the
pass that writes permanent memory is therefore something a plugin has to opt into
knowingly, through a differently-named hook, rather than something that quietly starts
happening to every plugin that already annotates replies.

One structural guard still holds either way: a fact is dropped unless it cites a message
id from the window, so a fact invented purely out of plugin text cannot be stored. What
remains is a fact that cites a real message but is *coloured* by what a plugin said.
That is the price of this hook, and it is why it is opt-in.

Contributions are labelled with the plugin's name and fenced off in the prompt as
background rather than material, with the model told not to turn any of it into a fact
and not to let it override what a message actually says. Like `annotateContext` it is
not chained, and a plugin that throws is logged and skipped.

`rolling-memory` is the plugin this exists for: its whole point is that the periodic
pass has the same short-term context the reply path does.

### `beforeReply`

```ts
export interface BeforeReplyContext extends PluginContext {
  taggedMessage: Message;
  draftPrompt: DraftPrompt;
}
beforeReply?(ctx: BeforeReplyContext): Promise<BeforeReplyResult | void> | BeforeReplyResult | void;
```

Fires from `handleMention` in `src/server/bot/replyPipeline.ts`. By this point the topic
has been extracted, facts have been retrieved from ChromaDB, their source messages
resolved, and a full `DraftPrompt` has been assembled — this is the last stop before the
reply-generation call. It is the only hook that can redirect the reply itself — replace
the whole draft, or skip it. `annotateContext`, immediately before it, can only add to
what the prompt says, not change what happens next. See section 4.

### `afterReply`

```ts
export interface AfterReplyContext extends PluginContext {
  taggedMessage: Message;
  sentMessageId: string | null; // null when the bot stayed silent, or failed
  silent: boolean;
}
afterReply?(ctx: AfterReplyContext): Promise<void> | void;
```

Fires once the reply is already in the channel. Nobody is waiting on it, so this is where
work that must happen but nobody should sit through belongs — a model call of your own,
tidying, bookkeeping. `rolling-memory` does its upkeep here for exactly that reason. A
throw is logged and swallowed: the reply has already succeeded and nothing here may
undo that.

All seven hooks are awaited **in sequence**, one plugin at a time, in a deterministic
load order (section 10) — never in parallel.

---

## 4. `beforeReply` in depth

`beforeReply` is **chained**: each enabled plugin that implements it runs in turn,
threading the draft through — each plugin sees the *previous* plugin's edits, not the
original.

```ts
export interface BeforeReplyResult {
  /** Replaces the draft the model will be given. */
  draftPrompt?: DraftPrompt;
  /** Aborts the reply entirely — use when a plugin has already responded itself. */
  skipReply?: boolean;
}
```

- Return `{ draftPrompt }` to replace what the model is handed. **You must return the
  whole `DraftPrompt`, not a patch** — spread the incoming one and change only what you
  need. A malformed value (missing a required field, wrong shape) is rejected: the
  engine checks it structurally, logs an error naming the plugin, and keeps the
  previous `draftPrompt` unchanged rather than handing the model something broken.
- Return `{ skipReply: true }` to abort: the reply pipeline returns immediately, so no
  reply is sent and **no remaining plugin in the chain runs**. Use this when your plugin
  has already handled the message itself (e.g. replied directly via
  `taggedMessage.reply(...)`).
- Returning `undefined`/nothing leaves `draftPrompt` untouched and continues the chain.
- A throw inside `beforeReply` is caught right there, logged, and treated as if the
  plugin had returned nothing — the chain continues with the `draftPrompt` unchanged
  from before that plugin ran.

`DraftPrompt`:

```ts
export interface DraftPrompt {
  systemInstruction: string;
  material: Record<string, unknown>; // the JSON document the model reads
  images: DraftImage[];              // pictures from the conversation
  retrievedFacts: Fact[];            // facts pulled from ChromaDB for this reply
  sourceMessages: SourceMessage[];   // the Discord messages those facts were derived from
}
```

- `systemInstruction` — the system prompt, already carrying every enabled plugin's
  `instructions` (section 7). Append to it rather than replacing it outright, unless you
  deliberately want to drop the base instruction.
- `material` — everything that changes from reply to reply, as one JSON document: `now`,
  `messages`, `people`, `memory.facts`, `channel`, `requester`, and whatever plugins have
  added. Add a key and it is a field the model can see; the rules for reading it belong in
  your `instructions`, which are cached, rather than in the data. Do not assemble prose
  here — the whole point is that the model is given data, and that message text is escaped
  so nobody can type their way into the structure.
- `images` — `{ messageId, mimeType, data }`, provider-neutral.
- `retrievedFacts` / `sourceMessages` — the facts already in `material.memory`, and the
  messages behind them. `retrievedFacts` is also what the reply log records.

Minimal example — appending a note to the system instruction:

```ts
beforeReply({ draftPrompt, getConfig }) {
  const { styleNote } = getConfig<{ styleNote: string }>();
  return {
    draftPrompt: {
      ...draftPrompt,
      systemInstruction: `${draftPrompt.systemInstruction}\n\n${styleNote}`,
    },
  };
},
```

Or adding a field of your own to the material:

```ts
beforeReply({ draftPrompt, database }) {
  return {
    draftPrompt: {
      ...draftPrompt,
      material: { ...draftPrompt.material, myPluginState: read(database) },
    },
  };
},
```

---

## 5. Tools

```ts
export interface PluginToolInvocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly requesterId: string;
  readonly requesterIsController: boolean;
  readonly requestContent: string;
}

export interface PluginToolContext extends PluginContext {
  readonly invocation: PluginToolInvocation;
}

export interface PluginTool {
  /** Lowercase with underscores, unique across plugins. Prefixed with the plugin id when registered. */
  name: string;
  /** Written for the model: say plainly when it should reach for this. */
  description: string;
  /** JSON Schema for the arguments. Use an empty properties object for none. */
  parameters: Record<string, unknown>;
  /** Offer and run this tool only for a requester configured as a controller. */
  requiresController?: boolean;
  /** Nothing is expected back: the reply finishes as soon as the message is written. */
  effect?: boolean;
  /** Offer and run this tool only while this top-level config key is exactly true. */
  enabledByConfig?: string;
  handler(args: Record<string, unknown>, ctx: PluginToolContext): Promise<unknown> | unknown;
}
```

A tool is a capability the model can decide to call while writing a reply. `name` only
has to be unique *within* your plugin — the engine namespaces it for the model as
`<plugin id with dashes turned to underscores>__<name>`, so `weather` on plugin
`weather-context` becomes the function `weather_context__weather`; two plugins can both
ship a tool called `lookup` without clashing.

The handler receives a `PluginToolContext`: the full `PluginContext` (section 9), plus
the host-built `invocation` for this reply. These fields are authoritative. They come
from the Discord message that started the turn, not from model-written tool arguments,
and the host hands the handler a frozen copy. Declare `requiresController` for the live
authorization gate; use `requesterId` and `requesterIsController` as authenticated turn
metadata and for any additional policy. Never accept an actor id or an "is admin" flag
from `args`. `guildId`, `channelId`, `messageId`, and `requestContent` tie the call to its
original Discord request.

Two declarative access gates cover the common cases:

- `effect: true` says nothing is expected back. Once the model has written its message and
  everything it called was one of these, the reply is finished then and there instead of
  going round again — which is both a round trip saved and one fewer chance for it to
  narrate what it just did. Reputation's assessment and rolling memory's bookkeeping are
  the shape this is for. A tool that answers a question the reply depends on must leave it
  off, or the model will never see what it asked for.
- `requiresController: true` keeps the tool out of the model's tool list unless the
  requester's Discord id is configured as a controller.
- `enabledByConfig: 'enableSomething'` keeps it out unless that top-level key in the
  plugin's **raw saved config** is exactly `true`. Missing, false, and truthy non-boolean
  values all disable it. Declare the key as a boolean in `configSchema` so the admin panel
  renders a switch.

The host filters tools before the model sees them, then evaluates both gates again
immediately before calling the handler. A controller-only tool requires both the
controller result authenticated at the start of the turn and a fresh lookup of the
requester id in `controllersRepo`; removing someone from Controllers while a reply is in
progress therefore cancels an already offered tool. The config gate likewise reads the
current raw config, so turning a switch off mid-reply prevents execution. On either
denial, the handler is not invoked and the model receives an error payload. These repeat
checks are the security boundary; hiding the declaration from the model is only the
first layer.

A tool without either property keeps the normal behavior and is offered to every reply
while its plugin is enabled. The handler can otherwise read or write facts, query its own
database, call an external API, or read its own config and secrets exactly like a hook.

Whatever the handler returns crosses back to the model as JSON. Return a plain object;
anything else is wrapped as `{ result: <value> }` so the model always gets a
predictable shape. **A handler that throws does not kill the reply** — the engine
catches it and hands the model `{ error: "<message>" }` instead, so it can say plainly
that the lookup failed rather than the whole turn erroring out.

Eligible tools from every enabled plugin are collected once per reply, but a **call budget**
(currently 10 calls total, shared across all plugin tools) bounds how many times the
model may invoke *any* plugin tool during that one reply — past the budget, plugin tools
are simply no longer offered to the model for the rest of that turn, so a tool that
answers with something that invites another call cannot loop forever.

Worked example — a lookup tool returning structured data:

```ts
tools: [
  {
    name: 'lookup_release',
    description: 'Look up the latest release version of one of our internal repos, by name.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name, e.g. "billing-service".' },
      },
      required: ['repo'],
    },
    async handler(args, ctx) {
      const repo = typeof args.repo === 'string' ? args.repo : '';
      if (!repo) return { error: 'repo is required' };

      const { GITHUB_TOKEN } = ctx.getEnv();
      const response = await fetch(`https://api.github.com/repos/acme/${repo}/releases/latest`, {
        headers: GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {},
      });
      if (!response.ok) return { error: `No release found for "${repo}"` };

      const release = (await response.json()) as { tag_name?: string; published_at?: string };
      return { repo, version: release.tag_name ?? 'unknown', publishedAt: release.published_at ?? null };
    },
  },
],
```

---

## 6. Panels and pages

Two shapes, and picking the wrong one is the most common mistake here.

A **panel** is a dialog. Use it for something small or one-off: a login form, a QR code
to scan, a connection status, a setup step, a destructive button. It opens over the
plugins list and closes again.

A **page** is a screen of your own data with its own route, `/plugins/<id>/<pageId>`,
reachable by clicking the page on the plugins list. Use it for anything an operator reads
and pages through: scores, memories, a log, a queue. It renders as a real table with
search and pagination, and it is where a plugin's data belongs — a hundred rows in a
dialog is a dialog being used as a page.

Both are listed on the plugins row. Neither is reachable for a plugin that is
incompatible or disabled.

### Pages

```ts
export interface PluginPage {
  id: string;
  title: string;
  description?: string;
  render(ctx: PluginContext, request: PluginPageRequest): Promise<PluginPageData> | PluginPageData;
  action?(actionId: string, rowId: string, ctx: PluginContext): Promise<PanelActionResult | void> | ...;
}

export interface PluginPageRequest {
  page: number;      // 1-based
  pageSize: number;
  query: string;     // '' when the search box is empty
}
```

**Paging is yours, not the panel's.** You are the only one who knows whether that means a
`LIMIT` or slicing an array, and handing back everything so the panel can slice it stops
working exactly when it starts mattering. Return the rows for the page you were asked for,
and `total` for every row matching `query` — the pager needs the total, not the slice.

```ts
return {
  columns: [
    { key: 'user', label: 'Person' },
    { key: 'score', label: 'Score', align: 'right' },
    { key: 'seen', label: 'Last seen', align: 'right', secondary: true },
  ],
  rows: page.map((row) => ({
    id: row.userId,
    cells: {
      user: { kind: 'user', id: row.userId },
      score: { kind: 'meter', value: row.score, label: `${row.hits}/${row.total}` },
      seen: { kind: 'time', at: row.updatedAt },
    },
    actions: [{ actionId: 'reset', label: 'Reset', tone: 'destructive', confirm: 'This cannot be undone.' }],
  })),
  total: matched.length,
  searchable: true,
  header: [{ type: 'text', tone: 'muted', text: 'What the numbers mean.' }],
  emptyMessage: 'Nothing here yet.',
};
```

Cell kinds: `text` (with `tone`), `user`, `channel`, `number` (with `suffix`), `meter` (a
0–1 proportion drawn as a bar, with an optional `label`), `time` (epoch millis, rendered as
how long ago), `badge` (with `tone`). `header` takes the same `PanelElement`s a panel does.
`align: 'right'` right-aligns a column and `secondary: true` hides it on a narrow screen.

A `text` cell gets the same treatment for free: any `<@id>` or `<#id>` inside it is
resolved and the panel renders it as a chip. You write the id, as you should, and the
operator reads a name.

**A tool's gates read live, and fall back to your `defaultConfig`.** `requiresController`
and `enabledByConfig` are re-checked immediately before the handler runs, so flipping a
switch in the panel takes effect on the next reply with no reload. The value is read from
the operator's stored config *over* your `defaultConfig`, which matters on an update: the
config row is written once, so a key you only added in a later version is simply absent
from it, and without the fallback a tool gated on that key would stay invisible until
somebody happened to re-save the settings form.

`controllerBypassConfig` names a config switch that stands `requiresController` down, for
a plugin that has a better test of its own than controller status. Discord Admin uses it
for autonomous moderation. Reach for it only when you are replacing the check with
another one — on its own it is just an off switch for the gate.

**When the text is long, set `preview`.** A row is one line, and a cell holding a whole
paragraph makes the table useless — which is what rolling memory's page did once memories
grew to a paragraph each. Give `preview` the opening words and the panel shows those in the
cell, with a **Show** button that opens the full `text` in a dialog:

```ts
text: { kind: 'text', text: memory.text, preview: memoryPreview(memory.text) },
```

Both strings travel in the same payload, so opening the dialog costs no request — which is
why this is not a row `action`, since those post to the server and refetch. Mentions
resolve in both, so a name reads the same in the table and in the dialog. Leave `preview`
unset and the cell renders exactly as it always has, so nothing needs changing.

Cut on a space if you write your own: a `<@id>` contains none, so cutting at a space
boundary means a mention is either wholly in the preview or wholly out, and never lands in
the table as a broken half-mention.

**`user` and `channel` carry the id, and the host resolves the name.** You store ids
because that is what survives somebody renaming themselves — the whole reason facts stopped
storing display names — which leaves you holding the one thing a person cannot read. Put
the id in the cell and a name comes out the other side, from the gateway first and the
message cache behind it. An id nothing can name falls back to itself.

For the cases that are not a cell — searching by name, writing a name into text —
`ctx.resolveUserNames(ids)` is the same lookup.

Buttons call `action(actionId, rowId, ctx)` and the table refetches afterwards, so
returning `{ tone, message }` is enough — there is no view to hand back.

A row button passes that row's own `id`. A button in `header` passes an **empty** `rowId`,
which is how a page-wide action — clear everything, export the lot — is told apart from one
aimed at a single row. That is why "reset everyone" is a button on the reputation page
rather than a dialog of its own.

### Panels

```ts
export interface PluginPanel {
  id: string;
  title: string;
  description?: string;
  render(ctx: PluginContext): Promise<PanelView> | PanelView;
  action?(
    actionId: string,
    values: Record<string, string>,
    ctx: PluginContext,
  ): Promise<PanelActionResult | void> | PanelActionResult | void;
}
```

A panel is a plugin's own corner of the admin panel — a login form, a QR code to scan, a
connection status. **Panels are declarative, never markup**: a panel returns a list of
typed elements, never HTML or a component, so nothing a plugin returns can inject
scripts into the admin page.

`PanelElement` — every variant:

```ts
export type PanelElement =
  | { type: 'text'; text: string; tone?: 'body' | 'muted' | 'success' | 'error' }
  | { type: 'heading'; text: string }
  | { type: 'status'; label: string; value: string; tone?: 'ok' | 'warn' | 'error' }
  | { type: 'image'; src: string; alt?: string; caption?: string }
  | {
      type: 'field';
      name: string;
      label: string;
      inputType?: 'text' | 'password' | 'number';
      placeholder?: string;
      value?: string;
      help?: string;
    }
  | { type: 'button'; actionId: string; label: string; tone?: 'default' | 'destructive'; confirm?: string }
  | { type: 'divider' };
```

`image.src` **must** be a `data:image/...;base64,` URI or an `https://` URL — anything
else is dropped by the engine before the view reaches the admin panel, so a plugin
cannot point the admin's browser at an arbitrary host. A QR code is the natural use of
`image`: render it as a `data:image/png;base64,...` URI.

`PanelView` is what `render` returns:

```ts
export interface PanelView {
  elements: PanelElement[];
  /** Re-fetch the panel automatically every N seconds — for a QR code being scanned. */
  pollSeconds?: number;
}
```

`pollSeconds` is how a login panel notices it has been scanned or completed without the
admin refreshing by hand — set it while waiting on something external, drop it once the
panel has settled. The engine clamps it to the 2–300 second range and ignores anything
smaller.

`action` runs when someone presses a `button` element, identified by its `actionId`, and
receives whatever is currently in the panel's `field` elements as `values` (keyed by
`name`). It returns a `PanelActionResult`:

```ts
export interface PanelActionResult {
  message?: string;
  tone?: 'success' | 'error';
  /** Render this instead of re-running render(). */
  view?: PanelView;
}
```

If `view` is omitted, the admin panel just shows `message`/`tone` and then re-runs
`render()` to refresh. A panel with no `action` at all is fine too — a pure status
display never needs one.

Worked example — a login panel with fields and a button:

```ts
panels: [
  {
    id: 'login',
    title: 'Account Login',
    description: 'Connect this plugin to your account.',

    render(ctx) {
      const { username } = ctx.getConfig<{ username?: string }>();
      return {
        elements: [
          { type: 'heading', text: 'Account Login' },
          username
            ? { type: 'status', label: 'Signed in as', value: username, tone: 'ok' }
            : { type: 'text', text: 'Not signed in.', tone: 'muted' },
          { type: 'divider' },
          { type: 'field', name: 'username', label: 'Username', inputType: 'text' },
          { type: 'field', name: 'password', label: 'Password', inputType: 'password' },
          { type: 'button', actionId: 'login', label: 'Sign in' },
        ],
      };
    },

    async action(actionId, values, ctx) {
      if (actionId !== 'login') return { tone: 'error', message: `Unknown action "${actionId}"` };
      if (!values.username || !values.password) {
        return { tone: 'error', message: 'Username and password are both required' };
      }

      // Verify against the real service here.
      ctx.storage.set('sessionToken', `token-for-${values.username}`);
      return { tone: 'success', message: `Signed in as ${values.username}` };
    },
  },
],
```

---

## 7. `instructions`

```ts
instructions?: string | ((ctx: PluginContext) => string);
```

Appended to the reply system prompt while the plugin is enabled — either a fixed string
or a function computed fresh per reply from the plugin's own context. This is where a
tool explains itself to the model: the tool's own `description` is what the model sees
when deciding whether to call it in a given turn, but `instructions` is the place to lay
out house rules or say plainly *when* a tool should be reached for at all ("only save a
quote when explicitly asked to remember one, never for ordinary chat").

A throwing `instructions` function is caught and logged like a hook; the plugin simply
contributes nothing to the prompt for that reply.

Keep it identical from call to call where you can. It sits in the system prompt, which the
provider caches; text that changes every reply belongs in `material` (section 4) instead,
where it costs a cache miss only on the part that actually changed.

### `aiTasks`

```ts
aiTasks?: Array<{ id: string; label: string; description?: string; needsImages?: boolean }>;
```

The jobs your plugin sends to a model. Declare them and the operator sees them by name in
Settings, and can give each its own ordered list of models — otherwise every plugin call
goes through the shared **Plugins** list. `ctx.generate` and `ctx.generateStructured` take
`task` to pick between them; leave it out and your first one is used.

```ts
aiTasks: [{ id: 'upkeep', label: 'Upkeep', description: 'Deciding what is worth keeping.' }],
```

You never name a model, a provider or an API key. What answers your call is the operator's
choice, and it can change under you without your plugin knowing or caring.

---

## 8. State: config vs secrets vs storage vs database

Four different stores, four different guarantees. Picking the wrong one either leaks a
key into a JSON blob an admin can read at a glance, or reaches for SQL where a single
key/value pair would do.

**config** — `getConfig<T>()`, backed by `defaultConfig` and `PATCH /api/plugins/:id`.
Plain JSON, stored unencrypted, edited in the admin panel. Use it for anything not
sensitive: channel IDs, thresholds, feature toggles, display strings. Read fresh on every
call — an admin-panel edit takes effect on the very next hook, tool, or panel render, no
restart.

Describe your settings with `configSchema` and the panel renders real controls instead of
a JSON textarea:

```ts
configSchema: [
  { name: 'maxQuotes', label: 'Maximum quotes', type: 'number', min: 1, max: 10000, step: 1,
    description: 'Oldest quotes are dropped past this.' },
  { name: 'channelId', label: 'Announce in', type: 'string', placeholder: '123456789012345678' },
  { name: 'style', label: 'Style', type: 'select',
    options: [{ value: 'plain', label: 'Plain' }, { value: 'fancy', label: 'Fancy' }] },
  { name: 'muted', label: 'Muted users', type: 'list', itemType: 'string' },
  { name: 'dryRun', label: 'Dry run', type: 'boolean' },
]
```

`string`, `text` (multiline), `number` (`min`/`max`/`step`), `boolean`, `select`
(`options`) and `list` (`itemType`). `description` becomes helper text under the control,
and `required` refuses to save empty.

The host coerces on save: a number arriving as a string is parsed and clamped, a `select`
outside its options is dropped, a `string` is trimmed. Fields already stored that the
schema does not mention survive a save; fields the panel sends that the schema does not
mention are ignored, since once you say what your settings are, that list is the contract.

**Declare a schema and you still validate at read time.** `getConfig<T>()` is an assertion
and nothing more: a config seeded before a field existed never grows it, and the coercion
only knows the bounds of one field at a time, so anything where two settings constrain each
other is still yours to sort out. `withDefaults` in the bundled plugins is the pattern.
Declare nothing and the JSON textarea stays, so an older plugin remains configurable.

**secrets** — `getEnv()`, for API keys and anything you would not want visible in a
config dump.

Declare the ones you need, and the panel shows the operator a labelled place to put each
before anything goes wrong rather than after:

```ts
secrets: [
  { name: 'API_TOKEN', label: 'API token', required: true,
    description: 'Encrypted at rest by the bot.', placeholder: 'sk_live_…' },
  { name: 'API_HOST', label: 'API host', default: 'https://api.example.com' },
]
```

A `default` is written once, on first install, and only into a name that has never been
set — an operator's value is never overwritten, and one they deliberately emptied stays
empty, because a default reappearing after you cleared it is indistinguishable from the
panel ignoring you. So a default is for something that is not itself a secret, like a host
name.

**A declared secret cannot be deleted, only emptied.** Deleting it would remove a row the
plugin still reads while the panel stops offering anywhere to put it back. An undeclared
one added by hand can still be deleted.

- Stored **encrypted at rest** (AES-256-GCM) — the plaintext never touches SQLite.
- Names must match `^[A-Z_][A-Z0-9_]{0,63}$` — `A-Z`, digits, underscores, starting with
  a letter or underscore.
- **Names are visible without extra auth** (`GET /:id/env/keys`), so the admin panel can
  show which variables a plugin expects. **Values require the admin password to be
  re-entered** — reading or writing them sits behind `requireElevated`, which needs a
  session elevated via `POST /api/auth/elevate` within the last **10 minutes**.
- The encryption key is `PLUGIN_ENV_KEY` (64 hex characters / 32 bytes) if set in the
  environment, otherwise one is generated on first use and written beside the SQLite
  file with `0o600` permissions. **Back this key up** — losing it makes every stored
  secret permanently unreadable (`readEnv` returns `''` per-row on a decryption
  failure rather than crashing, but the real value is gone).
- Secrets are **deleted with the plugin** — uninstalling clears them, so reinstalling
  later starts with nothing configured.

**storage** — `ctx.storage`, a scoped key/value store:

```ts
export interface PluginStorage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
  clear(): void;
}
```

Reach for this for a single remembered value that doesn't need a schema — a session
token, a pagination cursor, a last-seen timestamp. No other plugin can read or write
these rows; the scope is applied by the engine, not something the plugin passes in.

**database** — `ctx.database`, a `better-sqlite3` `Database`, entirely this plugin's
own file with full SQL: its own tables, its own indexes, its own migrations. Reach for
this once you have more than a couple of loosely related values, need to query
relationally, or want transactions.

- Opened on first access — a plugin that never touches `ctx.database` never gets a
  file.
- Kept **outside the plugin's own directory** (`<data dir>/plugin-data/<id>.sqlite3`),
  so reinstalling or updating the plugin's code does not touch its data.
- The plugin owns its schema — the bot never migrates it, and there is no migration
  hook. For a table or two, `CREATE TABLE IF NOT EXISTS` the first time you touch the
  database in a hook, tool or panel is enough. Beyond that, keep real migrations of your
  own; the bundled `reputation` does, and is worth copying (see below).
- Handles are closed before every reload (so a replaced plugin can't leave a stale file
  handle) and the file is deleted on uninstall.
- Drizzle works against it exactly as it does against the bot's own SQLite file — wrap
  `ctx.database` with `drizzle(ctx.database)` and define your own schema with
  `drizzle-orm/better-sqlite3`:

  ```ts
  import { drizzle } from 'drizzle-orm/better-sqlite3';
  import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

  const quotes = sqliteTable('quotes', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    author: text('author').notNull(),
    text: text('text').notNull(),
  });

  const db = drizzle(ctx.database);
  db.insert(quotes).values({ author: 'someone', text: 'a line' }).run();
  ```

- With drizzle you can carry proper migrations rather than creating tables on the fly.
  Put a `drizzle.config.ts` in your plugin pointing at your schema file and an output
  folder inside the plugin, generate with
  `npx drizzle-kit generate --config <your config>`, and apply them yourself on first
  use. Resolve the folder relative to your own module, since the plugin's code and its
  database live in different places:

  ```ts
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

  const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle');

  const migrated = new WeakSet<Database>();

  function open(database: Database) {
    const db = drizzle(database);
    if (!migrated.has(database)) {
      migrate(db, { migrationsFolder: MIGRATIONS });
      migrated.add(database);
    }
    return db;
  }
  ```

  The migrator is idempotent but not free, so run it once per handle rather than on
  every call. It keeps its own bookkeeping table inside your file, alongside your
  tables. `src/server/plugins/bundled/reputation/store.ts` is exactly this.

---

## 9. `PluginContext` and isolation

```ts
export interface PluginContext {
  factsCollection: Collection;
  saveFacts(candidates: FactCandidate[]): Promise<string[]>;
  resolveUserNames(ids: string[]): Record<string, string>;
  generate(request: PluginGenerateRequest): Promise<{ text: string }>;
  generateStructured<T>(request: PluginStructuredRequest): Promise<T>;
  discordClient: Client | null;
  getConfig<T = Record<string, unknown>>(): T;
  getEnv(): Record<string, string>;
  storage: PluginStorage;
  readonly database: Database;
}
```

- `factsCollection` — the shared ChromaDB collection. Facts are common ground, not
  private to a plugin, so this is the one thing here that is *not* scoped. Reading is
  what it is for.
- `saveFacts` — how to *write* one. It embeds the text, dedupes it against what is
  already stored, supersedes an older wording rather than leaving both, resolves any
  relative date, and writes the metadata shape the rest of the bot expects. Going at
  `factsCollection.add` directly skips all of that, so anything meant to last should
  come through here. It returns the ids actually created, which is fewer than you passed
  whenever a candidate duplicated something already known — that is the feature, not a
  failure.
- `resolveUserNames` — display names for Discord user ids, gateway first and message cache
  behind it. Ids nothing can name are simply absent from the result. Page cells of kind
  `user` are resolved for you; this is for everything else.
- `generate` — asks a model **through a list the operator configures**: models in order,
  tried best first, one that keeps failing rested and skipped, and the next tried instead.
  You pass `{ instruction, prompt, images?, task? }` and get `{ text }` back. Which models
  answer, and how hard they may think, is the operator's business, not yours. Throws once
  every model on the list has been tried and none answered.
- `generateStructured` — the same, for an answer your code reads. You pass a `schema`
  (`PluginJsonSchema`: objects with every property required, arrays, strings with an
  optional `enum` or `pattern`, numbers, booleans) and get that shape back, already checked
  against it. The host asks again by itself if the first answer does not fit, so anything
  you receive is usable. Throws if it cannot be read.
- `aiTasks` — declare the jobs you send to a model (see section 7). Each becomes a list in
  the panel once the operator switches your plugin off the shared one, and `task` on a
  request picks between them. There is no raw model client: a plugin never names a model,
  a provider or a key.
- `discordClient` — the logged-in `discord.js` client, or **`null`** when the gateway
  isn't connected. Hooks always have a live client, since Discord events are what
  trigger them; a panel or tool reached from the admin panel may run with the bot
  disconnected, so check for `null` before using it there.
- `getConfig` / `getEnv` / `storage` / `database` — scoped to this plugin alone, as
  covered in section 8.

Tool handlers receive `PluginToolContext`, which extends this interface with the
read-only `invocation` described in section 5. Hooks, instructions, panels, and pages do
not receive it: the metadata belongs to one model tool turn, not to a plugin globally.

The **raw bot database is deliberately absent**. An earlier version of this context
handed plugins the shared Drizzle instance directly, which meant any plugin could read
every other plugin's secrets by querying the tables behind their backs. The context you
get instead only ever reaches your own rows.

The object handed to a hook, tool, or panel is **frozen** (`Object.freeze`), and a tool's
`invocation` is frozen separately, so one plugin cannot rewrite the requester or patch a
function onto the context and have that stick for another plugin. Both are rebuilt fresh,
per plugin, on every invocation.

None of this is a sandbox. A plugin runs **in the bot process**, with full Node
privileges, and can `import` anything it likes — nothing stops it from reaching past
`ctx` for the bot's real database file, the file system, or the network directly. The
context narrows the *convenient* path so that ordinary, honestly-written plugins do not
accidentally step on each other or leak secrets into a config dump; it does nothing
against a plugin author who means harm. **Installing a plugin is running its author's
code as the bot.** Treat the ability to install one as equivalent to admin login itself.

---

## 10. Error handling and lifecycle

- **A package that fails validation or import is skipped, not fatal.** A missing or
  invalid `package.json`, an unusable `id`, or a `main` that does not exist is logged
  and that directory is skipped; every other plugin still loads. An import that throws
  (syntax error, missing dependency) is logged the same way. A default export with none
  of a hook, a tool, a panel, or `instructions` is logged and skipped too.
- **A throwing hook, tool handler, `instructions` function, or panel `render`/`action`
  is caught, logged, and swallowed** rather than taking the pipeline down — a hook or
  `instructions` call simply contributes nothing that turn, a tool call returns an
  `{ error }` payload to the model, and a panel shows its error inline instead of the
  admin panel breaking.
- **Disabled plugins are never invoked** — not even to check whether they would want to
  act.
- **Hooks await in sequence**, one plugin at a time. There is no parallel dispatch, so
  slow work in `onMessage` adds directly to how long every message takes to handle, not
  just ones that mention the bot.
- **Load order is sorted** (bundled plugins first, then installed ones, alphabetically
  by directory name within each), so `beforeReply` chaining is deterministic across
  restarts rather than depending on filesystem enumeration order.
- **Installing, uninstalling, and reloading all reload the registry immediately** —
  the entry file is imported with a cache-busting query string, so a new version of a
  plugin's code takes effect without restarting the process.

---

## 11. A complete worked example

Three bundled plugins exercise most of the surface, and all are worth reading alongside
this document rather than treated as toys.

`reputation` (`src/server/plugins/bundled/reputation/`) — `instructions`, a tool,
`annotateContext`, a typed `configSchema`, a page with a search box and per-row actions,
and its own drizzle database with generated migrations.

`rolling-memory` (`src/server/plugins/bundled/rolling-memory/`) — `onMessage`,
`beforeReply`, `annotateExtraction`, four tools, its own page, and `saveFacts` for
promoting something into permanent memory.

`discord-admin` (`src/server/plugins/bundled/discord-admin/`) — controller-only tools for
inspection, nicknames, timeouts, kicks, bans, member roles, role and channel-permission
management, and voice moderation. Each group has its own typed `enable*` config switch;
Discord's permissions and role hierarchy remain the final authority.
`requireMutationConfirmation` defaults to true, making every state change require an
exact, payload-bound phrase in a new controller message. Turning it off does not weaken
the hard floor: kicks, bans, role or overwrite deletion, and Administrator grants always
require confirmation.

Here is a fourth, smaller example covering the same ground from a different angle: two
tools trading data through one SQLite table, a config field, and a panel, but no
`annotateContext`.

`quote-book` lets the bot save a memorable line someone said and recall one later,
optionally filtered to a person, and gives the admin a panel listing recent quotes with
a button to clear them.

Directory, once installed:

```
<plugins dir>/quote-book/
  package.json
  index.ts
```

`package.json`:

```json
{
  "name": "quote-book",
  "version": "1.0.0",
  "description": "Lets the bot save memorable lines and recall them later, browsable from the admin panel.",
  "main": "index.ts",
  "type": "module",
  "bigYahu": {
    "displayName": "Quote Book"
  },
  "devDependencies": {
    "@big-yahu/plugin-sdk": "^4"
  }
}
```

The SDK dependency is not optional — its major is what declares the contract version.
Without it, and without a `bigYahu.apiVersion` to stand in, the plugin installs, is
listed, and never runs. See section 1.

`index.ts`:

```ts
import { definePlugin } from '@big-yahu/plugin-sdk';
import type { PanelElement, PluginContext } from '@big-yahu/plugin-sdk';

interface QuoteBookConfig {
  /** Oldest quotes are dropped once the table holds more than this. */
  maxQuotes: number;
}

interface QuoteRow {
  id: number;
  author: string;
  text: string;
  addedAt: number;
}

function ensureSchema(ctx: PluginContext): void {
  ctx.database.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      addedAt INTEGER NOT NULL
    )
  `);
}

function trimToLimit(ctx: PluginContext, limit: number): void {
  ctx.database
    .prepare(
      `DELETE FROM quotes WHERE id NOT IN (
         SELECT id FROM quotes ORDER BY addedAt DESC LIMIT ?
       )`,
    )
    .run(limit);
}

const plugin = definePlugin({
  id: 'quote-book',
  name: 'Quote Book',
  description: 'Lets the bot save memorable lines and recall them later, browsable from the admin panel.',
  version: '1.0.0',
  defaultConfig: { maxQuotes: 500 } satisfies QuoteBookConfig,

  instructions:
    'You can permanently remember a memorable line someone said with the quote_book__save_quote tool, and '
    + 'pull one back later with quote_book__random_quote. Use save_quote only when asked to remember something '
    + 'as a quote, not for an ordinary fact. Use random_quote when asked to share a quote, optionally about one person.',

  tools: [
    {
      name: 'save_quote',
      description: 'Save a memorable line, attributed to whoever said it.',
      parameters: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Who said it.' },
          text: { type: 'string', description: 'The line itself, verbatim.' },
        },
        required: ['author', 'text'],
      },
      handler(args, ctx) {
        const author = typeof args.author === 'string' ? args.author.trim() : '';
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!author || !text) return { error: 'author and text are both required' };

        ensureSchema(ctx);
        const { maxQuotes } = ctx.getConfig<QuoteBookConfig>();
        const addedAt = Date.now();
        const { lastInsertRowid } = ctx.database
          .prepare('INSERT INTO quotes (author, text, addedAt) VALUES (?, ?, ?)')
          .run(author, text, addedAt);
        trimToLimit(ctx, maxQuotes ?? 500);

        return { id: Number(lastInsertRowid), author, text };
      },
    },
    {
      name: 'random_quote',
      description: 'Recall a random saved quote, optionally filtered to one author.',
      parameters: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Only return a quote from this person, if given.' },
        },
      },
      handler(args, ctx) {
        ensureSchema(ctx);
        const author = typeof args.author === 'string' ? args.author.trim() : '';
        const row = author
          ? (ctx.database
              .prepare('SELECT * FROM quotes WHERE author = ? ORDER BY RANDOM() LIMIT 1')
              .get(author) as QuoteRow | undefined)
          : (ctx.database.prepare('SELECT * FROM quotes ORDER BY RANDOM() LIMIT 1').get() as QuoteRow | undefined);

        if (!row) return { error: author ? `No quotes saved for ${author}` : 'No quotes saved yet' };
        return { author: row.author, text: row.text };
      },
    },
  ],

  panels: [
    {
      id: 'quotes',
      title: 'Quote Book',
      description: 'Recent quotes the bot has saved.',

      render(ctx) {
        ensureSchema(ctx);
        const rows = ctx.database.prepare('SELECT * FROM quotes ORDER BY addedAt DESC LIMIT 20').all() as QuoteRow[];
        const total = (ctx.database.prepare('SELECT COUNT(*) AS n FROM quotes').get() as { n: number }).n;

        const quoteElements: PanelElement[] = rows.map((row) => ({
          type: 'text',
          text: `"${row.text}" — ${row.author}`,
        }));

        return {
          elements: [
            { type: 'heading', text: 'Quote Book' },
            { type: 'status', label: 'Quotes stored', value: String(total), tone: 'ok' },
            { type: 'divider' },
            ...quoteElements,
            { type: 'divider' },
            {
              type: 'button',
              actionId: 'clear',
              label: 'Delete all quotes',
              tone: 'destructive',
              confirm: 'This deletes every saved quote. Continue?',
            },
          ],
        };
      },

      action(actionId, _values, ctx) {
        if (actionId !== 'clear') return { tone: 'error', message: `Unknown action "${actionId}"` };
        ensureSchema(ctx);
        ctx.database.exec('DELETE FROM quotes');
        return { tone: 'success', message: 'All quotes deleted.' };
      },
    },
  ],
});

export default plugin;
```

Once installed and enabled, the model can call `quote_book__save_quote` when asked to
remember a line and `quote_book__random_quote` when asked to produce one back, both
backed by the plugin's own `quote-book.sqlite3` file rather than the shared fact store —
these are quotes, not facts, and do not go through ChromaDB at all. The admin panel gets
a "Quote Book" screen listing the 20 most recent, with a confirm-guarded button to wipe
the table. `maxQuotes` in its config caps how many rows are kept, trimmed on every save.

Note that the example imports its contract from `@big-yahu/plugin-sdk`, not from a
relative path into the bot source. That package is the supported boundary for installed
and bundled plugins alike; their positions on disk are deliberately irrelevant.
