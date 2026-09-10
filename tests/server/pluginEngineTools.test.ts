import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginToolContext,
  PluginToolInvocation,
} from '@big-yahu/plugin-sdk';
import type { ResolvedTool } from '../../src/server/plugins/engine';

const m = vi.hoisted(() => ({
  state: {
    enabled: true,
    config: { configuredEnabled: true } as Record<string, unknown>,
  },
  currentController: true,
  getFactsCollection: vi.fn().mockResolvedValue({}),
  seedPlugin: vi.fn(),
}));

// The workspace SDK is built by `npm run build`; this focused test runs against
// source without requiring its dist directory to exist first.
vi.mock('@big-yahu/plugin-sdk', () => ({
  HOOK_NAMES: [
    'onMessage', 'onHourlyCheck', 'onBotTagged', 'annotateContext', 'annotateExtraction', 'beforeReply',
  ],
  PLUGIN_API_VERSION: 3,
}));
vi.mock('../../src/server/plugins/manifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/plugins/manifest')>();
  const path = await import('node:path');
  return {
    ...original,
    BUNDLED_DIR: path.resolve('tests/fixtures/tool-plugins'),
    PLUGINS_DIR: path.resolve('node_modules/.tmp/plugin-engine-test-empty'),
    linkNodeModules: vi.fn(),
  };
});
vi.mock('../../src/server/db/chroma', () => ({ getFactsCollection: m.getFactsCollection }));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ addFacts: vi.fn() }));
vi.mock('../../src/server/ai/client', () => ({ ai: {} }));
vi.mock('../../src/server/ai/generate', () => ({ generate: vi.fn() }));
vi.mock('../../src/server/db/repositories/pluginStateRepo', () => ({
  getState: (id: string) => id === 'tool-test' ? m.state : undefined,
  listStates: () => ({ 'tool-test': m.state }),
  seedPlugin: m.seedPlugin,
  setState: vi.fn(),
}));
vi.mock('../../src/server/db/repositories/controllersRepo', () => ({
  isController: () => m.currentController,
}));
vi.mock('../../src/server/db/repositories/pluginEnvRepo', () => ({
  listEnvKeys: () => [], readEnv: () => ({}), setEnv: vi.fn(),
}));
vi.mock('../../src/server/db/repositories/pluginStorageRepo', () => ({ storageFor: () => ({}) }));
vi.mock('../../src/server/plugins/database', () => ({
  closeAllDatabases: vi.fn(), databaseFor: () => ({}),
}));
vi.mock('../../src/server/bot/identity', () => ({ knownDisplayNames: () => ({}) }));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({ getUsernames: () => ({}) }));

import { collectTools, loadPlugins, runTool } from '../../src/server/plugins/engine';

const invocation = (requesterIsController: boolean): PluginToolInvocation => ({
  guildId: 'guild',
  channelId: 'channel',
  messageId: 'message',
  requesterId: 'requester',
  requesterIsController,
  requestContent: 'please do it',
});

const names = (controller: boolean): string[] => collectTools(invocation(controller))
  .map((resolved) => resolved.declaration.name ?? '');

describe('plugin tool authorization gates', () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await loadPlugins();
  });

  beforeEach(() => {
    m.state.enabled = true;
    m.state.config = { configuredEnabled: true };
    m.currentController = true;
  });

  it('filters controller and raw boolean config gates before tools reach the model', () => {
    expect(names(false)).toEqual(['tool_test__open', 'tool_test__configured']);
    expect(names(true)).toEqual([
      'tool_test__open', 'tool_test__controller', 'tool_test__configured', 'tool_test__both',
    ]);

    m.state.config = { configuredEnabled: 'true' };
    expect(names(true)).toEqual(['tool_test__open', 'tool_test__controller']);
    m.state.config = { configuredEnabled: 1 };
    expect(names(true)).toEqual(['tool_test__open', 'tool_test__controller']);
  });

  it('rechecks both gates immediately before executing a previously resolved tool', async () => {
    const configured = collectTools(invocation(true)).find((tool) => tool.tool.name === 'configured');
    const controller = collectTools(invocation(true)).find((tool) => tool.tool.name === 'controller');
    expect(configured).toBeDefined();
    expect(controller).toBeDefined();

    const configuredHandler = vi.fn();
    const configuredCall = {
      ...configured!,
      tool: { ...configured!.tool, handler: configuredHandler },
    };
    m.state.config = { configuredEnabled: false };
    await expect(runTool(configuredCall, {}, invocation(true))).resolves.toEqual({
      error: 'This tool is disabled by the "configuredEnabled" plugin setting.',
    });
    expect(configuredHandler).not.toHaveBeenCalled();

    const controllerHandler = vi.fn();
    const controllerCall = {
      ...controller!,
      tool: { ...controller!.tool, handler: controllerHandler },
    };
    await expect(runTool(controllerCall, {}, invocation(false))).resolves.toEqual({
      error: 'This tool is restricted to bot controllers.',
    });
    expect(controllerHandler).not.toHaveBeenCalled();
  });

  it('does not execute a previously resolved tool after its plugin is disabled', async () => {
    const open = collectTools(invocation(true)).find((tool) => tool.tool.name === 'open');
    expect(open).toBeDefined();

    const handler = vi.fn();
    const openCall = { ...open!, tool: { ...open!.tool, handler } };
    m.state.enabled = false;

    await expect(runTool(openCall, {}, invocation(true))).resolves.toEqual({
      error: 'This plugin was disabled before the tool could run.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not execute a previously resolved controller tool after controller access is revoked', async () => {
    const controller = collectTools(invocation(true)).find((tool) => tool.tool.name === 'controller');
    expect(controller).toBeDefined();

    const handler = vi.fn();
    const controllerCall = { ...controller!, tool: { ...controller!.tool, handler } };
    m.currentController = false;

    await expect(runTool(controllerCall, {}, invocation(true))).resolves.toEqual({
      error: 'This tool is restricted to bot controllers.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a frozen copy of authoritative invocation data to the handler', async () => {
    let received: PluginToolContext | undefined;
    const handler = vi.fn((_args: Record<string, unknown>, ctx: PluginToolContext) => {
      received = ctx;
      return { ok: true };
    });
    const resolved: ResolvedTool = {
      pluginId: 'tool-test',
      declaration: { name: 'tool_test__direct' },
      tool: { name: 'direct', description: 'Direct', parameters: {}, handler },
    };
    const original = invocation(true);
    const resultPromise = runTool(resolved, { value: 1 }, original);
    (original as { requesterId: string }).requesterId = 'changed-after-dispatch';

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith({ value: 1 }, expect.any(Object));
    expect(received?.invocation.requesterId).toBe('requester');
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.invocation)).toBe(true);
  });
});
