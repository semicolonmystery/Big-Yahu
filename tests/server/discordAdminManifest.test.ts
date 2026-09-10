import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_DIR,
  PLUGIN_API_VERSION,
  incompatibilityReason,
  readManifest,
} from '../../src/server/plugins/manifest';

describe('Discord Admin bundled manifest', () => {
  it('is discoverable from the production bundled directory on plugin API v3', () => {
    const manifest = readManifest(path.join(BUNDLED_DIR, 'discord-admin'));

    expect(manifest).toMatchObject({
      id: 'discord-admin',
      name: 'Discord Admin',
      main: 'index.ts',
      apiVersion: PLUGIN_API_VERSION,
      apiVersionSource: 'sdk-dependency',
      apiVersionConflict: null,
    });
    expect(incompatibilityReason(manifest)).toBeNull();
  });
});
