# @big-yahu/plugin-sdk

The plugin contract for [Big Yahu](https://github.com/semicolonmystery/Big-Yahu) —
types, the hook names, and plugin API v3.

```bash
npm install --save-dev @big-yahu/plugin-sdk
```

A **devDependency**: everything here except `PLUGIN_API_VERSION`, `HOOK_NAMES`
and `definePlugin` is a type, so nothing of it exists at runtime and a
production install never fetches it.

```ts
import { definePlugin } from '@big-yahu/plugin-sdk';

export default definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'What it does, in one line.',
  version: '1.0.0',

  onMessage({ message, storage }) {
    storage.set('lastSeen', message.id);
  },
});
```

**Depending on this package is how you declare which contract you speak.** Its
major version *is* the contract version, so the range in your `package.json` says
it and there is nothing else to keep in step — updating the SDK is the whole of
updating your declaration.

```json
{ "devDependencies": { "@big-yahu/plugin-sdk": "^3" } }
```

API v3 deliberately does not load external v2 plugins. The host keeps each one listed as
incompatible until its SDK range is updated to `^3` and its tool handlers accept
`PluginToolContext` instead of `PluginContext`. SDK-less JavaScript plugins must set
`bigYahu.apiVersion` to `3` and use the same new handler context shape.

The bot reads that range out of your `package.json` rather than importing your
plugin to ask, because it checks compatibility *before* running your entry file:
a plugin written against a contract the host does not speak may do anything at
import time, and running its top level to find out it should not have run is the
wrong order.

If you do not use the SDK at all — plain JavaScript, no build step — say it
directly instead:

```json
{ "bigYahu": { "displayName": "My Plugin", "apiVersion": 3 } }
```

Do not do both. When the two disagree the plugin is refused rather than one
being quietly preferred, since that is precisely the drift this exists to
prevent. A git or tag dependency carries no version number and cannot be read,
so pair it with the explicit field.

Tool handlers receive `PluginToolContext`. Its frozen `invocation` identifies the
guild, channel, message and requester for the Discord turn, includes the original
request content, and says whether the host recognized the requester as a controller.
This metadata is host-built; do not take identity or authorization claims from tool
arguments.

Set `requiresController: true` to expose a tool only to controller requests, and
`enabledByConfig: 'enableMyTool'` to expose it only while that top-level raw config
value is exactly `true`. The host applies both gates before offering the tool and
again immediately before its handler runs. The second check reads current config and
the current controller store, so disabling a capability or removing the requester from
Controllers mid-turn prevents an already offered tool from executing.

Full authoring guide: [PLUGINS.md](https://github.com/semicolonmystery/Big-Yahu/blob/main/PLUGINS.md).

MIT.
