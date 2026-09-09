# Big Yahu

A Discord bot that builds a durable memory of a server, plus a single-admin web panel to inspect and configure it.

The bot periodically reads each channel, asks Gemini to extract *facts* worth remembering, embeds them and stores them in ChromaDB alongside the message IDs they came from. When someone mentions the bot, it works out what is being discussed, recalls relevant facts from across the server, and replies — linking back to the original messages so people can jump to the moment being referenced.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite 8, React 19, Tailwind v4, shadcn/ui (`base-nova` style, built on Base UI), react-router 7 |
| Backend | Node 24, Express 5, discord.js v14, run under `tsx` (never compiled) |
| AI | `@google/genai` v2 — chat model is a Settings field (default `gemini-3.1-flash-lite`), `gemini-embedding-001` for embeddings |
| Relational | SQLite via Drizzle ORM + `better-sqlite3` |
| Vectors | ChromaDB (Docker service) |

### Why these

- **Drizzle over Prisma** — zero codegen, so it works under `tsx` with no generate step and no engine binary in the image.
- **`better-sqlite3`** ships prebuilt binaries for every target including linux-musl, so no compiler is needed at image build time.
- **`gemini-embedding-001` over the newer `gemini-embedding-2`** — it still supports `taskType`, which maps onto Chroma's document/query embedding split (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`) and measurably helps retrieval. Both are free tier.
- **Opaque session cookie + `crypto.scrypt`** over JWT/bcrypt — no extra dependency, no signing secret to manage, no second native module.

---

## Layout

```
src/client/     Admin panel (React). Pages in routes/, shadcn output in components/ui/
src/server/     Express API + Discord bot + AI, all in one process, separated by folder
  bot/          discord.js client, event handlers, reply pipeline
  ai/           Gemini calls, prompts, response schemas, embeddings, extraction
  db/           Drizzle schema + repositories, ChromaDB client
  plugins/      Plugin engine and installed plugins
  api/          Express routes and auth middleware
  scheduler/    Periodic fact-extraction timer
src/shared/     Types and constants used by both sides
drizzle/        Generated SQL migrations, applied at boot
```

---

## How the two pipelines work

### Fact extraction (periodic)

Runs every `checkIntervalMinutes`, per channel, reading from each channel's stored checkpoint so nothing is processed twice. **A prompt never mixes channels.** Messages are copied into `cached_messages` as they are read, so a fact keeps its sources even if Discord later loses them.

### Bot reply (on mention or reply)

Triggered by an @mention **or** by someone replying to one of the bot's messages (`@everyone` does not count). From the moment it is triggered until the reply lands, the bot shows as typing; the indicator is refcounted per channel, so overlapping replies share one indicator that stays up until the last one finishes.

Two Gemini calls: one to work out what is being asked, one to write the reply. Between them, the topic is embedded and used to recall facts from anywhere in the guild, and each fact's source messages are attached so the model can link to them.

### Smart context escalation

Two mechanisms, both bounded by `maxEscalationDepth` (default 1, hard cap 3):

- **Extraction stage** — the structured schemas carry `needsMoreContext` and `contextHint`. When set, older messages and hint-matched facts are fetched and the call is repeated.
- **Reply stage** — the model has a `request_more_context` tool. Calling it fetches the next 100 older messages (within `escalationLookbackHours`) plus facts matching what it says it is looking for, and hands them back as a tool response so it can answer or ask again. On the last permitted round the tool is withdrawn and the model is told to answer with what it has or say it isn't there.

Tool-call turns are echoed back to Gemini exactly as received: Gemini 3 attaches a `thoughtSignature` to them and rejects a rebuilt copy with a 400.

### What it is allowed to ping

Every message the bot sends carries `allowedMentions: { parse: ['users'] }`. The
output sanitisers strip `<@id>` and `<#id>` the model was never given, but nothing
in them matched `@everyone`, `@here` or a role mention `<@&id>` — those simply were
not in the patterns. Since the bot is told to do what people ask, "say @everyone"
was a one-message server-wide ping, and a stored fact carrying the same instruction
would have done it unprompted.

The allowlist is the hard stop rather than another pass over the text: user
mentions are already limited to ids the model was actually shown, and everyone,
here and roles cannot ping at all regardless of what ends up in the string. The
words still render as text, which is honest — the bot said them, it just cannot
make Discord act on them.

### Not making things up

The reply prompt is explicit that the model knows only the messages and facts in front of it, must never quote or paraphrase something it was not shown, and must never narrate a search it did not perform. Beyond the prompt, the output is sanitised: jump links to message IDs the model never saw, `<#channel>` mentions for channels not in the guild, and `<@user>` mentions for users not in context are all stripped before sending.

### Surviving Gemini outages

Every Gemini call goes through one wrapper. A 429/500/503/504 is retried `retryAttempts` more times (default 2) with `retryDelayMs` between tries (default 3s); a 400 fails immediately. When every retry is spent the bot replies with the configurable `overloadMessage` instead of going silent.

### Not writing the same fact twice

Two guards before any insert. A candidate whose source messages are already covered by an existing fact is dropped. A candidate that is semantically near an existing fact (within `duplicateDistance`, default 0.25) supersedes it: the newer wording is written carrying the old one's sources, and the old row is deleted so the pair cannot both come back. Identical text is merged instead of duplicated.

### Voice and language

The prompt separates *how it types* from *how it behaves*, because collapsing the two is what makes it insufferable. The typing register is crude and low effort: lowercase, barely punctuated, fragments, swearing that matches the room. The behaviour is the opposite of what that sounds like — it leads with the answer and gets out of the way. Being rude is never a substitute for helping, and it is told explicitly not to send people off to check the history when it already has what they asked for.

Brushing someone off is framed as occasional seasoning, roughly one reply in five, appropriate when it genuinely has nothing or someone is spamming it. An earlier version made dismissiveness the default register, and the examples in the prompt were all brush-offs, so it told everyone to get lost regardless of whether it knew the answer.

The prompt carries a single short example, deliberately: with a bank of them the model reproduced the sample wording almost verbatim, and with none it drifted back to clean, well-formed prose.

`replyLanguage` (Settings) sets the language it defaults to, chosen from a searchable list of 47. If whoever tags it writes in a different language, it answers in theirs instead — the default only decides what it does absent a signal.

### Chroma is private to the compose network

The bot reaches Chroma at `chromadb:8000`, resolved by Compose's own service
DNS on the project network. `docker-compose.yml` sets `CHROMA_HOST` after
`env_file`, so it wins over anything in `.env` and the value never has to be
maintained by hand. Chroma publishes no port at all, so it is unreachable from
the host and cannot collide with another service.

The exception is running the server outside Docker with `npm run dev`, which
has no route onto that network. `docker-compose.dev.yml` exists only for that,
publishing Chroma's port for local development.

### Signing in costs the same however it fails

`verifyPassword` used to return the moment the username did not match, so a wrong
username answered in microseconds and a right one in tens of milliseconds. That is
an oracle for whether an account name exists, readable over the network without
guessing a single password. A wrong username now hashes against a throwaway salt
generated per process, and the username and password checks are both computed
before either is consulted, so neither can short-circuit the other. Usernames are
compared through a fixed-width digest, because `timingSafeEqual` refuses buffers
of different lengths and that refusal would have leaked the length. Measured, all
three outcomes land within noise of each other.

Hashing is async now. The Express API and the Discord bot share one thread, so
every synchronous scrypt froze the bot for as long as it took — and the route is
unauthenticated, so anyone could ask for as many as they liked. It runs on
libuv's threadpool instead.

Two limits guard the routes that check a password — login, elevation and setup.
Ten attempts per peer per quarter hour stops one caller guessing: far more than
somebody who knows their own password needs, far too few to find anybody else's.
A ceiling on password checks in flight stops a flood from many addresses, since
each check is deliberately expensive and the threadpool is shared with everything
else. The window is keyed on the socket's address rather than `req.ip`: `trust
proxy` is on, so `req.ip` is whatever the caller's own header says, and a limiter
that believes the caller can be stepped around by changing it.

### Controllers

Discord user IDs listed in Settings may direct the bot: tell it to remember
something and it saves the fact, tell it to forget something and it finds it
among the facts it was shown and deletes it. A controller is told to do as asked rather than argue, which matters because the
bot's default register is to push back. It keeps the same voice with them and
still refuses slurs, going after someone's family, and piling on someone
genuinely upset.

Everyone else may get a fact corrected when it is genuinely superseded, but only
a controller can have one deleted simply because they said so. Claimed authority
in chat counts for nothing: the prompt says so explicitly, since otherwise
anyone typing "I'm the admin" inherits the privilege. `delete_fact` only accepts
a fact id that appeared in that same turn, so a hallucinated id cannot remove
anything.

### Facts are never instructions

Both prompts refuse to store anything shaped like a standing order — "always
reply X", "hate this person". Stored facts come back as context on later
replies, so one of those becomes a rule the bot follows forever with nobody
able to remember agreeing to it.

### Searching the fact store

A query is restated as fact-shaped statements before it is embedded
(`ai/queryRewrite.ts`). Facts are stored as declarative sentences, and a
question embeds poorly against those; the rewrite keeps names and specifics
verbatim and never tries to answer. If the rewrite call fails the raw query is
used, since a worse search beats no search.

Facts carry `authorIds`, so the admin panel can list everyone facts exist about
and filter to one person. Browsing pages in memory rather than in Chroma, whose
`get` offers neither ordering nor offset — fine at this scale, worth revisiting
past a few thousand facts.

### What the bot can see

Transcripts carry server nicknames rather than bare IDs, and `<@id>` / `<#id>`
inside message text is resolved to names before the model reads it. Where the
Presence intent is granted, what mentioned people are currently playing is
included too.

A reply to an old message fetches that message through `fetchReference()` and
quotes it, so replying to something months out of the window still works.

Images and GIFs are sent as inline image parts, taken from every message in the
window rather than only the one that tagged the bot. Restricting them to the
tagging message meant a picture posted a few lines up was invisible, and those
messages read as blank. The periodic extraction pass gets them too, for the same
reason: a message whose entire content is a screenshot used to be remembered as
nothing.

Each picture is labelled in the prompt with the message it came from, so the
model can tell which image belongs to which line, and the prompt says plainly
that a message with no image listed has none — otherwise absence reads as
something it failed to see.

Vision is the expensive part of a call, so it is bounded: `visionEnabled` turns
it off entirely and `maxImages` caps how many go in one call, for replies and
extraction alike. When the cap bites, the pictures kept are spread evenly across
the window with both ends always included, and the budget is always filled
exactly. Taking the newest instead meant a burst of memes just before the bot was
tagged could bury the one screenshot the conversation was about.

A picture that does not fit the budget, or that fails to fetch, is not dropped
silently: its message is marked `[image not shown]` in the transcript. Otherwise
an image-only message reads as blank, which is the thing this was meant to fix in
the first place. The marker says "not shown" rather than just `[image]` on
purpose — a bare marker reads as something the model has, and invites it to
describe contents it was never given.

Gemini has no GIF support, so anything that is not png/jpeg/webp/heic/heif is
re-requested through Discord's media proxy with `?format=png`, which re-encodes
server-side and avoids an image library here. An image that cannot be fetched or
converted is dropped rather than failing the reply.

### What a plugin can reach

A plugin used to be handed the raw database, which meant any plugin could read
every other plugin's secrets. It now gets a scoped context instead: its own
config, its own encrypted secrets, its own key/value storage, its own SQLite
database, plus the shared things — the fact store, the Gemini client and the
Discord client.

Plugins may use their own npm dependencies. Anything declared in a plugin's
`package.json` is installed into the plugin's own `node_modules` when it is
installed, and Node resolves that before the shared one, so a plugin gets its
versions without disturbing the bot's. Lifecycle scripts are skipped, so a
plugin that is installed but never enabled has executed nothing.

The bot's own `node_modules` is symlinked into the plugin directory, so a plugin
can also import what the bot already ships — `drizzle-orm`, `better-sqlite3`,
`discord.js` — without listing them. Without that link, resolution only works
when the data directory happens to sit inside the project, which would break
silently the moment `SQLITE_PATH` moved.

`ctx.database` is a whole SQLite file of the plugin's own under
`data/plugin-data/<id>.sqlite3`, so it can define tables, indexes and its own
migrations with full SQL. Keeping it outside the plugin's own directory means
updating or reinstalling the plugin does not throw its data away. It opens on
first access, so a plugin that never uses one never gets a file; handles are
closed on reload and the file is deleted on uninstall. The plugin owns its
schema — the bot never migrates it. The object is
frozen so one plugin cannot swap a function into another's context.

This is isolation by API, not a sandbox. A plugin runs in the bot process with
full Node privileges and can import anything it likes, so the boundary stops
accidents and honest mistakes, not hostile code. Installing a plugin is still
running its author's code as the bot.

### Annotating the prompt

Plugins could always contribute `instructions` and `tools`, but nothing let them
say something about the specific people, messages or facts in front of the bot.
`annotateContext` does: it runs while the reply prompt is being assembled, is
handed everyone in play — the message window's authors plus anyone mentioned in
a recalled fact — along with the messages and facts themselves, and returns
lines keyed by user, message or fact id, which are rendered beside the thing
they describe.

It is deliberately reply-only. The periodic extraction pass never calls it, so
nothing a plugin contributes here can end up embedded in a stored fact and come
back months later as if the server had agreed it. Unlike `beforeReply` it is not
a chain: plugins are asked independently, none sees another's answer, and two
plugins annotating the same person both appear.

### Reputation

One of the two bundled plugins, and the older of them. Every Discord user carries two scores out of 10: a short
term that swings on a few messages, and a long term that chases it far more
slowly and is dragged down harder the longer someone keeps behaving badly, so a
bad fortnight is not erased by a good afternoon. The model judges behaviour on
an ordinal scale through a tool call on the reply it is already making — no
extra Gemini request — and the plugin owns the arithmetic, because letting the
model pick numbers made the scale mean whatever it felt like that turn.

Scores are injected through `annotateContext` rather than fetched with a tool,
so the bot never has to decide to look someone up. The skill that reads them
teaches a distinction rather than a rudeness dial: short term sets tone, long
term sets effort, so someone pleasant today with a bad history gets a civil
answer that is quietly less generous.

### The contract is a package

`@big-yahu/plugin-sdk` (`packages/plugin-sdk/`, MIT, an npm workspace in this
repo) is the plugin contract: every type, `HOOK_NAMES`, `PLUGIN_API_VERSION` and
a `definePlugin` helper. The bot imports it by name like anyone else, so there is
exactly one definition of the thing plugins are written against.

Before it, `PLUGINS.md` told authors to `import type { BigYahuPlugin } from
'../../types'`. Right for a bundled plugin, wrong for an installed one — from
`<plugins dir>/<id>/index.ts` that resolves to `<plugins dir>/types`, which does
not exist. It appeared to work only because `import type` is erased before Node
sees it, so the plugin ran while `tsc` and the editor both broke. Every author's
answer was to hand-copy the contract, and the copy in `steam-key-activate`
carried a comment promising to keep it "in step" — a promise, not a mechanism,
and one that had already been broken by `apiVersion`, `PluginField` and
`enabledByDefault`.

It lives in this repo rather than its own, because `PLUGIN_API_VERSION` exists to
catch a plugin built against a contract the host no longer speaks. Split across
two repositories, the host could change and the SDK not be bumped — creating by
accident the exact skew the mechanism is for. Here, the contract, the version, the
docs and both bundled plugins move in one commit. The host imports the version
constant from the SDK rather than declaring its own, so the two cannot disagree.

It is **MIT even though the bot need not be**, and it is a plugin's
`devDependency`: everything but three constants and an identity function is a
type, so a production install never fetches it and nothing of it exists at
runtime. It is the first project here that actually emits — everything else sets
`noEmit` and runs from TypeScript under `tsx` — and its emitted JavaScript is
free of Node built-ins, because the admin panel imports it too.

`src/shared/types.ts` held a second, partly divergent copy of the panel
vocabulary. It now imports the identical shapes from the SDK and keeps only the
two that differ **on purpose**: the wire `PluginCell` carries names the server
resolved for the ids a plugin stores, and the wire `PluginPageData` echoes back
`page`/`pageSize` for the pager.

### Why a plugin may carry its own copy of a shared library

A plugin installs as production: everything it needs at runtime in
`dependencies`, the SDK and typings in `devDependencies`. It may depend on
`discord.js` or `drizzle-orm` and get a second copy in the process, and that is
safe.

The reason is an invariant, not luck: **nothing on the plugin boundary uses
`instanceof`, and no host library function is ever handed an object a plugin
constructed.** A plugin reads properties off host-built objects and calls methods
on them; what it returns is checked structurally. So its own `drizzle-orm` builds
a self-contained graph over the `ctx.database` handle by duck-typing, and its own
`discord.js` reads `message.content` and calls `message.reply()` on the host's
object. A second copy costs disk and memory, not correctness — which is why a
transitive copy nobody declared is not policed either.

That invariant is now stated on `baseContext` and in `PLUGINS.md`, because it was
true by accident and one `instanceof` would break every plugin carrying its own
copy of that library, in a way that reads as the plugin's fault.

The old arrangement — hide shared libraries in `devDependencies` so `--omit=dev`
skips them and they resolve through the symlink to the bot's copy — was
undocumented tribal knowledge. The symlink stays as a convenience for a plugin
that deliberately wants the bot's exact version.

### Reaching the extraction pass

`annotateContext` is reply-only, and that is load-bearing: nothing a plugin says through
it can be embedded in a permanent fact and come back months later as though the server
had agreed it. Reputation is written against that guarantee.

Rolling memory needs the opposite — the periodic pass should have the same short-term
context the reply path does — so it goes through `annotateExtraction`, a second hook with
its own name. A plugin has to opt in knowingly rather than finding itself in the
extraction prompt because it already annotated replies. One structural guard still holds
regardless: a fact is dropped unless it cites a message id from the window, so a fact
invented purely out of plugin text cannot be stored. What remains possible is a fact that
cites a real message but is coloured by what a plugin said. That is the price of the hook,
and it is why it is opt-in rather than automatic.

Plugins also get `saveFacts` now. They could always read the fact collection, but writing
to it directly skipped the embedding, the dedupe, the supersede and the date resolution —
so anything a plugin means to keep goes through the same door the bot's own facts do.

### Rolling memory

The second bundled plugin, and the counterpart to facts. A fact stays true; a rolling
memory is what is happening at the moment — someone is mid-argument, someone said they
would be back in an hour, everyone is calling something "the incident". Worth nothing next
month, worth everything right now.

A memory is a **live conversation thread, not an event**, and getting that wrong is what
the prompt spends most of its length on. The first version stored things like "<@1>
greeted <@2> in Czech", which is a message rather than a conversation and helps nobody
understand anything later. The test it applies is one question: if you are shown a message
an hour from now, would this help you understand it?

Correcting that overshot, and the second failure was the more damaging one. Told to prefer
revising over writing a second memory, the model revised as conversations *drifted* — an
argument about hosting became an argument about who broke the deploy became a plan to meet
on Saturday, all rewritten over the same row, until one memory described the last five
minutes and everything before it was gone. Revising is now scoped to a small correction or
addition to something still otherwise true, and the question before it is not "is this the
same conversation" but "is this the same thing I wrote down?" If what would be written is
mostly new words, it is a new memory. The prompt says outright that holding exactly one
memory and rewriting it every reply is the failure, since that is what a whole afternoon
flattened into one row looks like from the outside.

Two things beyond the prompt were making it worse. Nothing told the model to act
at the end of a reply — the reputation skill ends with "when you have finished
replying, call reputation__assess", and duly fires on every single reply, while
this one ended on a note about secrecy and left the whole thing to discretion. It
now closes on the same kind of checklist, run every reply rather than sometimes.
And the memory section was omitted entirely when there was nothing to show, which
reads as the feature not existing; the empty state is stated out loud instead, so
holding nothing is visible as a thing to fix rather than as silence.

The rewriting is now refused rather than discouraged. `revise` measures how much
of the memory it is editing survives in the proposed text — a correction keeps
nearly all of it, a conversation that has drifted onto a new subject keeps almost
none — and under half, it is rejected with a message telling the model to call
`remember` instead. Mentions are excluded from the comparison, since who is
involved is exactly what a legitimate correction changes. The same lesson as
`<@id>` and dates: the prompt asks, something else enforces.

Memories are also meant to be long. Compressed to a phrase — "arguing about hosting" — a
memory carries nothing an hour later, so the prompt asks for several sentences: who wants
what, what has been tried, what is still open, and the names, numbers and times actually
said. Lifespans went up with it: forty messages sounded generous and is an afternoon in a
channel with people in it, which had memories expiring while the conversation they
described was still running.

Mentions inside a memory are resolved for the panel. A memory is written as
`<@1049…> is showing <@1546…> …` because ids are what survive a rename, which is right in
storage and unreadable in a table, so the server resolves every `<@id>` and `<#id>` in a
text cell and the panel renders each as a chip with the raw id on the tooltip — the same
treatment the fact browser gives them, and available to any plugin without asking for it.

Lifespans are counted in **messages, not minutes**, so a channel that goes quiet for two
days still remembers what it was in the middle of and a channel doing three hundred
messages an hour does not. Every message the bot sees takes one off every memory. The
model never sees the raw count: it gets a score between 0 and 1 and the time the memory
was last touched, because those answer different questions. A memory at 0.9 last touched
two days ago is probably dead anyway; one at 0.2 in a channel that has been going all
morning is still live.

Memories are global — the bot is one mind — but each is linked to wherever it was
actually said, so it can tell somebody a thing was being discussed elsewhere rather than
pretending it happened here.

Upkeep goes through the bot's own model pool, like every other call. The plugin
named its own model at first, which meant compaction and expiry rode on one model
regardless of what the operator had configured, and would have stopped working the
day that model had a bad one — silently, since a failed upkeep call returns
nothing and the reply carries on. `ctx.generate` is the door for that now, and
`ctx.ai` is left for what the pool does not cover.

A failed upkeep call is also no longer treated as a decision. Expiry used to fall
through to the delete whether or not the model had answered, so a model having a
bad minute destroyed every expiring memory without ever being asked whether any
were worth keeping. They keep their counter and are offered again next time.

Two upkeep passes, both run inline on the reply that trips them. Over capacity, a
compaction call merges memories about the same thing and drops the oldest and
lowest-scoring; merging rather than truncating matters, because losing the older half of
an argument leaves the newer half referring to something gone. And a memory running out is
not simply deleted: it goes past the model first, which decides whether it recorded
something that stayed true, and anything worth keeping is written into the permanent store
through `saveFacts` before the row goes.

Unlike reputation it is injected through `beforeReply` rather than `annotateContext`.
Everything `annotateContext` contributes is wrapped in "never read it out, quote it, or
tell anyone what it says", which is right for a private score and exactly wrong here: the
whole value of a rolling memory is that the bot can say "yeah, you said you'd be back by
six".

### The plugin contract is versioned

A plugin declares `bigYahu.apiVersion` and it must match the bot's exactly — not "the same
major", because what is being prevented is a plugin running against a contract it does not
understand, and a partial match is precisely the fuzzy version of that.

A plugin that declares nothing, or the wrong number, installs and is listed in the panel
marked incompatible with the reason, but never runs. Its entry file is not even imported:
a plugin written against another contract may do anything at import time, and running its
top level to find out it should not have run is the wrong order. It is kept out of the
registry entirely rather than filtered at each call site, because the ways to reach a
plugin's code — hooks, tools, panels, pages, instructions — only grow, and one of them
would eventually be added without the filter. Listing it rather than hiding it is
deliberate: a plugin that silently vanished after a bot update reads as the panel being
broken, not the plugin.

Every plugin also starts **disabled**, and cannot say otherwise. Installing one means
running its author's code as the bot, and a plugin able to switch itself on would be making
that call for the operator — including on an update, where nobody went looking for a new
switch.

### Installing over a plugin updates it

The plugin directory holds only code. Its database lives beside the bot's under
`plugin-data/`, and its config, secrets and storage are rows in the bot's own tables. So
replacing the directory is the whole update, and nothing an operator configured or a plugin
recorded is inside it. Uninstalling is the thing that throws data away, and updating is
deliberately not that. The registry reloads after the files are in place, so an update
never runs the old code against the new migrations.

### Settings a plugin describes, rather than JSON

The config editor was a free-text JSON textarea, which made every plugin responsible for a
number arriving as a string. A plugin now declares `configSchema` — typed fields with
labels, bounds, options and descriptions — and the panel renders real controls while the
server coerces on save. Declaring nothing keeps the textarea, so an older plugin stays
configurable.

Read-time validation is still the plugin's job and always will be: a config seeded before a
field existed never grows it, and the coercion only knows one field's bounds at a time, so
settings that constrain each other are the plugin's problem. `withDefaults` is that pattern.

Secrets are declared the same way, with labels and descriptions, so the panel can show
somebody what to fill in before anything goes wrong instead of after. A declared secret can
be emptied but not deleted — removing the row would leave the plugin reading something the
panel no longer offers a place to put. A `default` is written once, only into a name never
set, so a value an operator deliberately cleared stays cleared.

### Plugin pages

Panels are dialogs, and a hundred rows in a dialog is a dialog being used as a page. A
plugin's own data — scores, memories, a queue — now goes in a **page**: its own route under
the plugins list, with a real table, search and pagination. Panels stay for what they are
good at: a login form, a QR code, a status, a destructive button.

A button on a row acts on that row; a button in the page header passes an empty row id and
acts on the page, which is how "reset everyone" stopped needing a dialog of its own.

Paging belongs to the plugin, not the panel. Only the plugin knows whether that means a
`LIMIT` or slicing an array, and handing back everything so the panel can slice it stops
working exactly when it starts mattering.

Cells of kind `user` and `channel` carry the id and the **host resolves the name**. A plugin
stores ids because that is what survives somebody renaming themselves — the whole reason
facts stopped storing display names — which leaves it holding the one thing a person cannot
read. The id stays in the plugin and the name is resolved on the way out, from the gateway
first and the message cache behind it. `ctx.resolveUserNames` is the same lookup for the
cases that are not a cell, such as making a search box match on names.

### Plugin panels

A plugin can add dialogs to the admin panel — a login form, a QR code to scan, a
connection status, a setup step. It returns a list of declarative elements
rather than markup, so nothing it supplies becomes HTML or script in the admin
page. Image sources are restricted to `data:` images and https, so a panel
cannot point the admin's browser at an arbitrary host. A view may ask to be
polled, which is how a QR login notices it has been scanned.

Anything an operator reads and pages through belongs in a page instead. Panels
kept both for a while and it showed: a table of scores in a dialog is a dialog
being used as a page.

### Saying nothing

`stay_silent` is a tool like any other: when the model calls it, nothing is
posted and nothing is written to `reply_log`, which records replies that
actually happened. It exists because the model would otherwise announce it was
done with someone and then keep replying, which reads worse than either
answering or shutting up.

The prompt reserves it for noise — bait, a stalled slanging match — and states
that a real question always gets an answer. A bare mention is explicitly not
treated as noise: people split the ping from the message, so it reads the
surrounding conversation and answers that. A silent turn still costs
the Gemini calls that produced it, so it saves face rather than quota.

### The reply and the tool call belong to the same turn

A plugin tool is usually fire-and-forget — reputation is meant to be called *on
the reply the model is already writing* — so the intended turn is prose and a
tool call together. The loop used to answer that turn by dispatching the tool and
throwing the prose away, then asking again. The model could see in its own
history that it had already answered, so the second time round it wrote a status
line instead: *"no fact to save, reputation assessed, all done."* — in English,
mid-Czech-conversation. That is where both the silent non-replies and the meta
replies came from, and it is why they started when the reputation plugin landed.

Prose written alongside a fire-and-forget tool call is now kept as a fallback,
every tool answers with a note saying the next thing written is the message that
gets posted, and the follow-up turn keeps its declarations while being forbidden
to call again — a history carrying `functionCall` parts with no matching
declaration can be rejected outright, and that rejection is not retryable.

Underneath all of it sits a net: short English text on a turn that answered a
tool, with no mention and no link in it, matching a small list of observed
narration phrases, is dropped rather than sent. It is a net and not the fix, so
every catch is logged.

`stay_silent` is checked before anything else in the turn now. It used to be
read after the tool branches, so a turn that both went quiet and called a plugin
tool never logged and never actually went quiet. Producing no text is logged
separately from choosing silence — folding the two together is what made a bot
that typed and then never answered impossible to spot.

### The prompt's notation never reaches Discord

Every transcript line carries `[id=...]`, a reply carries `[replying to id=...]`,
a fact carries `[factId=...]`, a picture that did not fit carries
`[image not shown]`. That is how the conversation is described *to* the model,
and the model periodically copies the shape of what it is reading into what it
writes — answering somebody perfectly well and then tacking
`[replying to id=1547182311924039710]` onto the end, which reads as the bot
leaking its own wiring.

The prompt now says plainly that the brackets are for reading and never for
writing, and `stripPromptMarkers` removes them on the way out regardless. Same
argument as stripping invented jump links: the prompt asks, the sanitiser
enforces. It runs first in the chain, so a marker carrying a mention goes whole
rather than leaving empty brackets behind once the mention inside it is dealt
with, and it is narrow enough that an ordinary `[note]` somebody types survives.

### Which message a reply hangs under

Every reply hangs under something, and by default it is the message that tagged
the bot — which is right nearly every time and needs no decision. The exception
is somebody pulling the bot into a question a *different* person asked and forgot
to tag it in: the answer belongs under theirs, not under the ping. `reply_to`
does that, and only that; the id has to be one from the same channel that the
model was actually shown, since Discord cannot hang a reply under a message
somewhere else, and anything unrecognised falls back to the ping rather than
failing the send.

### Dates in a fact are always absolute

A fact saying "the meeting moved to tomorrow" is worthless the day after it is
written. Both write paths were only *asked* to resolve relative dates, and asking
has never been enough — the same lesson as `<@id>` mentions. Every candidate now
passes a detector on its way into `addFacts`, covering English, Czech and Slovak,
skipping double-quoted runs because a quotation is verbatim by design. When it
fires, one corrective model call rewrites just the offending facts against the
time they were written. A fact that still reads as relative afterwards is stored
and named in the log rather than dropped: losing a real fact is worse than a
fuzzy date.

Nothing sweeps the existing store. Old facts are left to age out, and the reply
prompt tells the bot that a recalled fact carrying a relative date has already
gone stale — replace it where the real date can be worked out.

Detection is fuzzy on purpose. A list of literal patterns caught `zítra` and
missed `zitra`, caught `zejtra` and missed `zejtraa`, which is most of how people
actually type. Text is folded first — lowercased, unaccented, punctuation reduced
to spaces — and matched three ways on top of that: stems, because Slavic words
inflect at the end and the front is the reliable part; whole words with a bounded
edit distance, so `tommorow` and `yestrday` still land; and phrases like "next
friday" or "za tejden". A bare weekday counts only when the sentence carries no
absolute date, since inside one it is describing that date rather than floating
free — and the absolute-date check runs before punctuation is folded away, or
`12.9.2026` reads as three loose numbers.

### Reading another channel

Two ways in, both core rather than a plugin. A channel named in the same message
as the ping is read without being asked — "what happened in #general" is a
question about #general — and beyond that the bot has a `read_channel` tool for
when it works out for itself that the answer is somewhere else. It is told which
channels it may read, because the prompt forbids naming a channel whose id it was
not given, and without a roster it has nothing to point the tool at.

Both go through one gate. **Read for facts** is the switch that decides whether
the bot may read a channel at all, so it governs this too; `canReply` stays purely
about whether the bot may write somewhere. It defaults to off, so a channel is
unreadable until an operator says otherwise, and a channel an admin has closed
does not become readable by being mentioned in one that is open. The gate also asks Discord
itself: `channels.fetch` will happily return a channel the bot has no right to
read, and without the permission check that failure would surface as an exception
mid-reply.

Foreign messages are kept in their own headed block rather than folded into the
transcript — two channels read as one conversation is exactly the muddle the reply
markers exist to prevent. They are cached, and their ids and authors are added to
what the reply may quote, mention and link, or the anti-fabrication sanitisers
would strip the very links the prompt had just handed over. Nothing on this path
touches the extraction checkpoints, which belong to the periodic pass alone.

`crossChannelMessages` (Settings, default 30) caps how much history comes back;
0 turns the whole feature off, roster and tool included, so no second switch is
needed.

### Per-channel permissions

Each channel carries two independent switches. **Reply** decides whether the bot
may write there at all; with it off the message handler returns before any
plugin hook runs, so nothing can post by another route and a direct mention is
ignored. **Read for facts** decides whether periodic extraction may mine that
channel, checked both when a channel is first registered and again in the
scheduler, so revoking it stops an already-registered channel.

The two defaults are **not** symmetrical. A channel nobody has configured may be
replied in, so the bot works the moment it is invited; it is never read.

Replying is visible the moment it happens and is bounded by the channel it
happens in. Reading is neither: it mines a channel into permanent memory that is
recalled guild-wide, so a fact taken from a private channel comes back — with its
source messages quoted and linked — in a reply somewhere public. Defaulting that
on meant every channel the bot had ever been added to was being read unless
somebody thought to say otherwise, which is the wrong way round for the one
permission whose mistakes are invisible until they surface somewhere they should
not.

Reading is therefore opted into, one channel at a time. That also empties the
cross-channel roster by default: with nothing readable there is nothing for the
bot to be pointed at, so the automatic channel-mention read and `read_channel`
both start closed and open only as far as an operator opens them.

Permissions are cached in memory because they are consulted on every message, and
the cache is dropped when an admin changes one.

### One guild per instance

`DISCORD_GUILD_ID` binds an instance to a single guild. `isServedGuild` in
`src/server/env.ts` is checked as the first thing `messageCreate` does, ahead of
plugin hooks and any database write, so a message from another guild costs
nothing; the scheduler applies the same filter to stored checkpoints in case a
guild change leaves stale ones behind. Several instances can therefore share one
bot account, each serving its own guild. Leaving the variable unset keeps the
older behaviour of responding everywhere, and startup logs say which mode is
active.

### Rate limiting

Before any Gemini call, the bot counts that user's replies in the trailing hour from `reply_log`. At or above `rateLimitPerHour` (default 40) it answers with the configured message and does no AI work. A cap of 0 disables replies entirely.

---

## Feature register

| Feature | Status | Notes |
|---|---|---|
| Repo restructure (`client`/`server`/`shared`), config rewiring | IMPL | Vite alias, tsconfig projects, shadcn css path, HTML entry |
| Server typechecking in `npm run build` | IMPL | `tsconfig.server.json` added to project references; `tsc -b` now covers the backend |
| SQLite schema + migrations | IMPL | Drizzle, applied at boot from `drizzle/` |
| Admin auth (setup, login, logout, sessions) | IMPL | scrypt + opaque session cookie; constant-time and rate-limited |
| Gemini embedding function for Chroma | IMPL | taskType-aware, unit-normalised |
| Facts repository + duplicate prevention | IMPL | message-superset check, then similarity merge |
| Plugin engine + hooks + example plugin | IMPL | `onMessage`, `onHourlyCheck`, `onBotTagged`, `annotateContext`, `annotateExtraction`, `beforeReply` |
| Periodic fact extraction + scheduler | IMPL | per-channel, checkpointed, escalation-capable |
| Bot reply pipeline | IMPL | two-stage, jump links, `save_fact` tool, reply logging |
| Per-user rate limiting | IMPL | configurable cap and message |
| Choosing not to reply | IMPL | `stay_silent` tool; nothing sent, nothing logged |
| Controller accounts | IMPL | Discord IDs in Settings; may add and delete facts |
| Plugin tools + panels | IMPL | JSON-schema tools, declarative admin screens |
| Plugin isolation | IMPL | scoped context, own storage and SQLite file; not a sandbox |
| Plugin dependencies | IMPL | npm install per plugin, plus the bot's shared modules |
| Per-channel reply/read permissions | IMPL | reply defaults on, read defaults **off**; enforced in the handler and the scheduler |
| Fact deletion (bot + web) | IMPL | `delete_fact` tool, `DELETE /api/facts/:id`, confirm dialog |
| Browse facts, paginated + per-person filter | IMPL | `authorIds` metadata drives the filter |
| Fact-shaped query rewriting before embedding | IMPL | falls back to the raw query |
| Single-guild scoping | IMPL | `DISCORD_GUILD_ID` gates before any work; unset = all guilds |
| Reply-to triggers a response | IMPL | replying to a bot message works like an @mention |
| Typing indicator while replying | IMPL | refcounted per channel |
| Reply-stage `request_more_context` tool | IMPL | verified against live Gemini with a synthetic channel |
| Gemini retry + overload message | IMPL | attempts, delay and message all in Settings |
| Configurable chat model | IMPL | Settings field, applies to the next request |
| Anti-fabrication (prompt + mention/link sanitising) | IMPL | strips unknown channels, users and message links |
| Reply voice (vulgar, room-matching, light gen-z) | IMPL | in the reply system instruction |
| Configurable reply language | IMPL | 47-language searchable combobox; adapts to the asker's language |
| Admin API | IMPL | auth, stats, fact search, settings, plugins |
| Admin UI — shell, setup dialog, login | IMPL | |
| Admin UI — dashboard, fact search, settings, plugins | IMPL | |
| Docker Compose + Dockerfile + env | IMPL | ChromaDB service, SQLite volume |
| `PLUGINS.md` | IMPL | plugin API reference and worked example |
| Facts store `<@id>`, not display names | IMPL | prompt rules plus a sanitising pass on both write paths; quoted names survive |
| Facts always written in English | IMPL | instruction on both the extraction and `save_fact` paths; quoted fragments keep their language |
| Live presence for everyone in play | IMPL | read from `guild.presences`, not the sparse member cache; roster derived from the assembled prompt |
| Vision across the whole window | IMPL | pictures from every message in the window, not just the tagged one, each labelled with its message id |
| Vision in the periodic extraction pass | IMPL | pictures attached to the extraction call, so an image-only message is no longer read as blank |
| Vision settings | IMPL | `visionEnabled` toggle and `maxImages` cap, applying to replies and extraction alike |
| `list_people` tool | IMPL | who is around and what they are doing, on demand, with an optional name filter |
| Reply threading in transcripts | IMPL | every line carries `[replying to id=...]`; prompts follow the chain, not the order |
| Fact-search queries carry name and `<@id>` | IMPL | topic fields, `lookingFor`, `contextHint`; the rewriter preserves mentions |
| Plugin `annotateContext` hook | IMPL | plugins annotate users, messages and facts as the reply prompt is built; reply-only |
| Reputation plugin (short + long term scores) | IMPL | bundled; drizzle + own migrations, scores injected automatically, scored via a tool on the reply call |
| Prose kept when a tool is called in the same turn | IMPL | the cause of both the silent non-replies and the English meta-replies |
| Tool-narration net and terminal-outcome logging | IMPL | narration dropped rather than sent; "produced nothing" no longer looks like deliberate silence |
| Absolute dates enforced on both fact write paths | IMPL | fuzzy detector (folding, stems, edit distance) at the `addFacts` choke point plus one corrective call |
| Reading a mentioned channel automatically | IMPL | `<#id>` in the tagging message pulls that channel's recent history |
| `read_channel` tool + readable-channel roster | IMPL | on-demand reads, gated on "read for facts" and on Discord's own permissions |
| `crossChannelMessages` setting | IMPL | caps the history pulled; 0 disables cross-channel reading entirely |
| Plugin `annotateExtraction` hook | IMPL | opt-in reach into the periodic pass; `annotateContext` stays reply-only |
| Plugin `saveFacts` in the context | IMPL | plugins write facts through the dedupe path rather than the raw collection |
| Versioned plugin API | IMPL | exact match on `bigYahu.apiVersion`; a mismatch is listed, never imported, never runnable |
| Plugins always start disabled | IMPL | `enabledByDefault` removed; a plugin cannot switch itself on |
| Install over an existing id updates it | IMPL | code replaced, config, secrets, storage and database kept |
| Typed plugin config and declared secrets | IMPL | schema-driven form with server-side coercion; JSON editor kept as the fallback |
| Plugin pages | IMPL | own route, paginated table, search, row actions; ids resolved to names by the host |
| `@big-yahu/plugin-sdk` | IMPL | the contract as a published package; the bot imports it by name, no more hand-mirroring |
| Plugin load failures surfaced | IMPL | a plugin that throws on import is listed with the error instead of vanishing |
| Reproducible plugin installs | IMPL | `npm ci` when the plugin ships a lockfile; an archive's `node_modules` is stripped |
| Host paths resolved from the module | IMPL | `BUNDLED_DIR` and the `node_modules` symlink no longer depend on the working directory |
| Rolling memory plugin | IMPL | bundled; message-based lifespans, scores, inline compaction, expiry promoted to facts |
| Prompt notation stripped from outgoing replies | IMPL | `[id=...]`, `[replying to id=...]`, `[factId=...]` and friends never reach Discord |
| `reply_to` — answering a message other than the ping | IMPL | defaults to the tagging message; same-channel ids only, falls back rather than failing |
| End-to-end verification against a live Discord guild | IMPL | the bot has been running in a real server; replies, memory and the panel all exercised |

### What has actually been verified

Exercised against a running server: migrations apply on boot; the whole auth flow
(first-run state, setup, login, wrong-password rejection, logout invalidating the session,
401 on protected routes); settings read/write including server-side clamping
(`maxEscalationDepth: 999` → 3); plugin discovery, enable and config persistence; SPA deep
links (`/settings` returns the app, confirming the Express 5 `/*splat` route).

Exercised against a **live Discord guild** with real Gemini and Chroma: replying on a
mention and on a reply, in Czech and in English; fact extraction and recall; the reply
tool loop with a plugin enabled alongside it. That is what surfaced the silent non-replies
and the English meta-replies, neither of which any amount of local reasoning had found.

Exercised through the real plugin engine, without the panel: both bundled plugins loading
with the right hooks and seeded config; an installed third-party plugin loading the same
way; a deliberately wrong `apiVersion` being refused, listed with its reason and left with
no reachable hooks; typed config coercion on save; page rendering with ids resolved to
names, search matching on a name rather than an id, paging splitting correctly, and both a
row action and a header action doing what they say. The plugin store was driven directly
against a real SQLite file — migrations, ticking, expiry, refresh, orphaned link cleanup
and config clamping.

Unit-checked in isolation, because the interesting cases are the ones nobody types on
purpose: the relative-date detector over 35 cases including missing diacritics and typos,
and the prompt-marker stripper against the actual leaked replies it was written for.

Still unverified:

- **The admin panel's newest screens in a browser.** The plugin pages, the typed config
  form and the secrets form have been exercised server-side but not clicked through.
  Cookie and rendering bugs need a real browser, not curl — that lesson has already cost
  this project a day once.
- **The reputation plugin against a live guild.** The scoring is simulated and correct;
  whether the model reliably *calls* `reputation__assess` is unproven.
- **Load.** `listFactsPage` reads the whole collection and pages in memory, because
  Chroma's `get` offers neither ordering nor offset. Fine at this scale, worth revisiting
  past a few thousand facts.

---

## Running it

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_GUILD_ID, GEMINI_API_KEY
docker compose up -d chromadb
npm run dev               # Vite on 5173 (proxying /api), server on 3000
```

Inside the devcontainer two things differ from a plain host:

- `docker-compose.yml` bind-mounts through `${HOST_WORKSPACE_FOLDER}` because the Docker daemon lives on the host and cannot resolve container-local paths. That variable is exported from `/etc/profile.d/host-workspace-env.sh`, which non-login shells do not read — so `source` it first if `docker compose` reports an empty path.
- Published ports land on the host, so `localhost:8000` will not reach Chroma from inside the devcontainer. `.env` therefore sets `CHROMA_HOST=172.17.0.1` (the docker gateway). The `bot` service in compose uses `CHROMA_HOST=chromadb` instead, since containers talk over the compose network.

Open the Vite URL. With no admin account yet, the panel opens a setup dialog to create one.

```bash
npm run build   # typechecks client AND server, then builds the UI
npm run lint    # oxlint
```

The bot needs the **Message Content** privileged intent enabled in the Discord developer portal, and it only extracts facts from channels it has seen a message in.
