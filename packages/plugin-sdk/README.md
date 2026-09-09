# @big-yahu/plugin-sdk

The plugin contract for [Big Yahu](https://github.com/semicolonmystery/Big-Yahu) —
types, the hook names, and the plugin API version.

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

Your `package.json` must declare the contract version, or the bot will list the
plugin as incompatible and run none of it:

```json
{ "bigYahu": { "displayName": "My Plugin", "apiVersion": 1 } }
```

This package's major version tracks `PLUGIN_API_VERSION`, so `^1` says which
contract you speak and npm enforces it.

Full authoring guide: [PLUGINS.md](https://github.com/semicolonmystery/Big-Yahu/blob/main/PLUGINS.md).

MIT.
