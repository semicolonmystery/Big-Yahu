# Big Yahu

A Discord bot that remembers what a server talks about.

On a timer it reads through each channel, has Gemini pick out the things worth
remembering, and stores them as embeddings in ChromaDB alongside the messages
they came from. When you mention it or reply to it, it looks up what is
relevant, answers, and links back to the original messages.

It ships with a web admin panel for browsing what it has learned and changing
how it behaves.

## Features

- **Automatic memory.** Periodically scans channels for new messages and
  extracts facts, one channel at a time. Keeps a per-channel checkpoint so
  nothing is read twice, and merges near-duplicates instead of piling up
  copies of the same thing.
- **Answers with sources.** Retrieves relevant facts from across the server and
  links to the messages they came from, so you can jump to the original.
- **Digs for context.** If the answer depends on something older than what it
  can see, it asks for more history rather than guessing, up to a configurable
  depth.
- **Stays honest.** It is told to answer only from what it was given, and
  anything it invents is filtered out before sending: message links, channel
  mentions and user mentions that were not in its context are stripped.
- **Configurable voice.** Replies in a set language by default and switches to
  whatever language it was addressed in.
- **Sees pictures.** Images from anywhere in the recent window are sent along
  with the text, each labelled with the message it came from, for replies and
  for the periodic scan alike. Capped and switchable, since vision is the
  expensive part of a call.
- **Reads message.txt.** UTF-8 Discord attachments named `message.txt` are read
  as labelled message content. Settings controls their maximum size (16 KiB by
  default, 0 to disable, hard cap 64 KiB). One context shares a 64 KiB budget,
  at most eight files and two files per message. Downloads time out after five
  seconds, reject redirects and stop at the byte limit while streaming.
- **Reads the room.** Transcripts carry who is replying to whom, so interleaved
  conversations can be told apart, and it can see who is around and what they
  are playing.
- **Looks in other channels.** A channel mentioned alongside the ping is read
  automatically, and it can ask to read any channel it is allowed to. Channels
  with reading switched off stay off.
- **Handles rate limits.** Retries transient Gemini errors with a configurable
  count and delay, and falls back to a message you choose if it stays down.
  Per-user hourly reply caps are configurable too.
- **One guild.** `DISCORD_GUILD_ID` is required in bot mode. Every other guild
  is ignored before any work, and an absent guild never enables a global mode.
- **Per-channel control.** Reading for facts and replying are separate switches
  per channel, enforced in the message handler and the scheduler alike. Replying
  is on by default; **reading is off** until you enable it channel by channel,
  since anything learned from a channel can be recalled in any other.
- **Plugins.** Hook into `onMessage`, `onHourlyCheck`, `onBotTagged`,
  `annotateContext`, `annotateExtraction` and `beforeReply`, lend the bot new
  tools, describe your settings so the panel renders real controls, and add
  your own paginated screens to the admin panel. The contract is versioned, and
  plugins keep their data across an update. See [PLUGINS.md](PLUGINS.md).

Two plugins ship with it, both off until you turn them on:

- **Reputation** — tracks how each person treats the bot over time on two
  scores, one that swings quickly and one that barely moves, and quietly shapes
  how much effort they get back.
- **Rolling memory** — a short working memory of what is being discussed right
  now, measured in messages rather than minutes, so a quiet channel does not
  forget where it was. Anything still worth keeping when it runs out is
  promoted into permanent memory.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, run it for your
server, build on it and share what you build — all of that is fine, for any
noncommercial purpose. Charities, schools and public institutions count as
noncommercial whatever their funding.

What it does not allow is making money from it. If you want to run it
commercially, sell it, or build a paid service on top, ask me and we can agree
terms.

Note that this is deliberately **not** an open source licence in the OSI sense,
since it discriminates against commercial use. If that matters for what you are
doing, it is better to know now than after you have written a plugin.

## Requirements

- Docker and Docker Compose
- A Discord bot token, with **Message Content** and **Presence** intents enabled
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Getting started

```bash
git clone https://github.com/semicolonmystery/Big-Yahu.git
cd Big-Yahu
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_GUILD_ID` and `GEMINI_API_KEY` in `.env`, then:

```bash
docker compose up -d
```

Open <http://localhost:3000>. On first run the panel asks you to create the
admin account.

Enable the **Message Content** and **Presence** privileged intents in the
Discord Developer Portal before starting the bot.

## Configuration

`.env` holds only what is needed to start:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_GUILD_ID` | The server the bot runs in |
| `GEMINI_API_KEY` | Google AI Studio API key |
| `SQLITE_PATH` | Optional. Where the SQLite file is written |
| `PORT` | Optional. Port the admin panel and API listen on |

Chroma needs no configuration. Under Compose the bot reaches it by service name
on the project's private network, so it is never published to the host and its
port cannot clash with anything.

Everything else is edited in the admin panel and takes effect without a
restart: the Gemini models and the order they are tried in, how often channels
are scanned, how much context is read, how deep it may dig for history, how
much of another channel it may pull in, vision and its image budget, reply
language, rate limits, retry policy and the messages it sends when limits are
hit.

## Development

Requires Node 24. The version is also enforced in `package.json`.

```bash
npm ci
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d chromadb
npm run dev
```

The server runs outside Docker here, so it cannot use the compose network to
reach Chroma. `docker-compose.dev.yml` publishes Chroma's port for that case
and should never be layered onto a deployment.

`npm run dev` starts Vite and the server together. The Vite dev server proxies
`/api` to the backend.

```bash
npm run build   # typechecks client and server, then builds the UI
npm run lint    # oxlint
npm run check   # build, test typechecking, lint and coverage
npm test        # offline unit, component and HTTP/SQLite regression tests
npm run test:coverage
npx playwright install chromium
npm run test:e2e # real browser + isolated admin server, no Discord/Gemini calls
```

Database migrations are generated with `npx drizzle-kit generate` and applied
automatically when the server starts.

The bot requires exactly one `DISCORD_GUILD_ID` and a Gemini key whenever a
Discord token is configured. Enable both Message Content and Presence intents
in the Discord developer portal. With no Discord token, the admin panel can run
on its own. `/api/health` checks SQLite and, in bot mode, Discord and Chroma.

Core memory writes from replies respect the channel's read-for-facts switch. Core
retrieval also hides facts and source messages from channels whose reading has
been disabled; existing stored records are preserved for the admin to manage.
The per-user hourly limit counts admitted AI work, including failed and silent
attempts, and survives restart. Only one reply per user and four replies total
can be in flight. Each reply has a 24-request AI budget and a two-minute AI
deadline; retries and embeddings count towards that budget.
Chroma requests have fresh ten-second timeouts and inherit the reply deadline.
Waiting for retries or queued memory writes also stops when that deadline expires.

For an isolated Chroma check, set `CHROMA_HOST` and `CHROMA_PORT` to a test server
and run `npm run test:integration`. It uses deterministic embeddings and its own
temporary collection, never a Gemini key or the bot's facts collection. CI runs
Windows/Linux checks, the browser flow, a real Chroma check, and production
image startup/shutdown.

Before upgrading an existing deployment, stop the bot and back up both `data/`
and `chroma_data/`, including the generated plugin encryption key. Chroma is
pinned; use `CHROMA_IMAGE` to retain an existing server image until its upgrade
has been tested against a backup. Plugin code and its lifecycle are maintained
separately from the core reliability changes.

### Running inside a devcontainer

If Docker runs on the host rather than in your dev environment, two things
differ. Bind mount paths must be host paths, so set `HOST_WORKSPACE_FOLDER` to
this directory's location on the host before running Compose. And published
ports land on the host rather than in your dev environment, so when using the
dev overlay above, set `CHROMA_HOST=172.17.0.1` (the Docker gateway) instead of
`localhost`. Running everything through Compose needs neither.

## Architecture

```
src/client/    Admin panel (React, Vite, Tailwind, shadcn/ui)
src/server/
  bot/         discord.js client, event handlers, reply pipeline
  ai/          Gemini calls, prompts, schemas, embeddings, extraction
  db/          Drizzle schema and repositories, ChromaDB client
  plugins/     Plugin engine and installed plugins
  api/         Express routes and auth
  scheduler/   Periodic fact extraction
src/shared/    Types and constants used by both sides
```

SQLite holds the admin account, settings, plugin state, reply log and a cache
of message text. ChromaDB holds the fact embeddings and their metadata. Each
plugin gets a SQLite file of its own, kept outside its directory so updating
the plugin does not throw its data away.

[PROJECT.md](PROJECT.md) explains how the pipelines work and why they are built
the way they are; [PLUGINS.md](PLUGINS.md) is the plugin authoring guide.
