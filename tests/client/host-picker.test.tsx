// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AiTasksSection } from '../../src/client/components/settings/AiTasksSection';
import { api } from '../../src/client/lib/api';
import type { AiTasksOverview, CatalogEndpoint } from '../../src/shared/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const host = (tag: string, extra: Partial<CatalogEndpoint> = {}): CatalogEndpoint => ({
  tag,
  providerName: 'Google AI Studio',
  promptPrice: 0.125,
  completionPrice: 0.75,
  cacheReadPrice: 0.0125,
  timeOfDayPricing: false,
  tools: true,
  jsonMode: true,
  healthy: true,
  ...extra,
});

/** One task with one model, pinned to a host spelled the way the server stores it. */
const overview = (upstream: string): AiTasksOverview => ({
  tasks: [{
    // The panel opens on the reply tab, so that is the task whose rows render.
    id: 'reply',
    label: 'Reply',
    description: 'Writes the answer.',
    usesImages: true,
    usesTools: true,
    structured: false,
    reasoningEffort: 'none',
    models: [{
      task: 'reply', model: 'google/gemini-3.5-flash-lite', upstream,
      weight: 100, failures: 0, restingUntil: null, retiredAt: null, retiredReason: null,
      lastError: null, createdAt: 0, capabilities: null,
    }],
    warnings: [],
  }],
  plugins: [],
  catalogAvailable: true,
  openrouterConfigured: true,
} as unknown as AiTasksOverview);

function stub(upstream: string, hosts: CatalogEndpoint[]) {
  vi.spyOn(api, 'aiTasks').mockResolvedValue(overview(upstream));
  vi.spyOn(api, 'modelHosts').mockResolvedValue(hosts);
  return vi.spyOn(api, 'setTaskModelUpstream').mockResolvedValue(overview(upstream));
}

describe('pinning a model to a host', () => {
  it('shows the slug exactly as it is stored and sent, with no display name or price', async () => {
    stub('google-ai-studio/flex', [host('google-ai-studio/flex'), host('google-vertex/global')]);
    render(<AiTasksSection />);

    const trigger = await screen.findByRole('combobox', { name: 'Host for google/gemini-3.5-flash-lite' });
    await waitFor(() => expect(trigger.textContent).toContain('google-ai-studio/flex'));
    // The provider's display name and its prices are what made the control
    // unsearchable and two hosts from one provider indistinguishable.
    expect(trigger.textContent).not.toContain('Google AI Studio');
    expect(trigger.textContent).not.toContain('$');
  });

  it('loads the hosts without waiting to be opened', async () => {
    stub('google-ai-studio/flex', [host('google-ai-studio/flex')]);
    render(<AiTasksSection />);
    // Opening a picker whose list was still empty is what let the value be
    // reconciled against a list of one.
    await waitFor(() => expect(api.modelHosts).toHaveBeenCalledWith('google/gemini-3.5-flash-lite'));
  });

  // The bug: opening the picker on a row already pinned to its host silently
  // repinned it to a differently-spelled one from the catalog.
  it('never repins a row on its own, however the stored slug is spelled', async () => {
    for (const stored of ['google-ai-studio/flex', 'deepseek', 'a-host-the-catalog-forgot']) {
      const pin = stub(stored, [host('google-ai-studio/flex'), host('deepseek/fp8')]);
      render(<AiTasksSection />);
      await waitFor(() => expect(api.modelHosts).toHaveBeenCalled());
      await waitFor(() => expect(
        screen.getByRole('combobox', { name: 'Host for google/gemini-3.5-flash-lite' }).textContent,
      ).toContain(stored));
      expect(pin, stored).not.toHaveBeenCalled();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('keeps a stored slug the catalog does not list, rather than dropping it', async () => {
    stub('a-host-the-catalog-forgot', [host('google-ai-studio/flex')]);
    render(<AiTasksSection />);
    const trigger = await screen.findByRole('combobox', { name: 'Host for google/gemini-3.5-flash-lite' });
    await waitFor(() => expect(trigger.textContent).toContain('a-host-the-catalog-forgot'));
  });

  it('still shows the stored slug when the catalog cannot be read at all', async () => {
    vi.spyOn(api, 'aiTasks').mockResolvedValue(overview('deepseek'));
    vi.spyOn(api, 'modelHosts').mockRejectedValue(new Error('catalog is down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pin = vi.spyOn(api, 'setTaskModelUpstream').mockResolvedValue(overview('deepseek'));
    render(<AiTasksSection />);

    const trigger = await screen.findByRole('combobox', { name: 'Host for google/gemini-3.5-flash-lite' });
    await waitFor(() => expect(trigger.textContent).toContain('deepseek'));
    expect(pin).not.toHaveBeenCalled();
  });
});
