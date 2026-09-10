import type { BigYahuPlugin } from '@big-yahu/plugin-sdk';

const parameters = { type: 'object', properties: {} };
const handler = () => ({ ok: true });

export default {
  id: 'ignored-manifest-wins',
  name: 'Ignored manifest wins',
  description: 'Fixture export identity is replaced by the manifest.',
  version: '0.0.0',
  tools: [
    { name: 'open', description: 'Open tool', parameters, handler },
    { name: 'controller', description: 'Controller tool', parameters, requiresController: true, handler },
    { name: 'configured', description: 'Configured tool', parameters, enabledByConfig: 'configuredEnabled', handler },
    {
      name: 'both',
      description: 'Controller and configured tool',
      parameters,
      requiresController: true,
      enabledByConfig: 'configuredEnabled',
      handler,
    },
    {
      name: 'bypassable',
      description: 'Controller tool the plugin may take over gating for',
      parameters,
      requiresController: true,
      controllerBypassConfig: 'autonomyOn',
      handler,
    },
    {
      name: 'defaulted',
      description: 'Gated on a key only the shipped defaults carry',
      parameters,
      enabledByConfig: 'addedInAnUpdate',
      handler,
    },
  ],
  // The stored row predates `addedInAnUpdate`, so only this supplies it.
  defaultConfig: { addedInAnUpdate: true },
} satisfies BigYahuPlugin;
