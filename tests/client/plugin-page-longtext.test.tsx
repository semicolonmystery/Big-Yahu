// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PluginPage from '../../src/client/routes/PluginPage';
import { api } from '../../src/client/lib/api';
import type { PluginPageData, PluginSummary } from '../../src/shared/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const MENTION = '<@500000000000000001>';
const FULL = `A long memory in which ${MENTION} argued about hosting for most of the evening, `
  + 'tried three providers, and left the question of who pays for it entirely unresolved.';
const PREVIEW = `A long memory in which ${MENTION} argued about…`;

const plugin: PluginSummary = {
  id: 'rolling-memory', name: 'Rolling Memory', description: 'Short-term memory', version: '1.0.0',
  hooks: [], enabled: true, config: {}, bundled: true, apiVersion: 3, incompatibleReason: null,
  configSchema: null, secrets: [], pages: [{ id: 'memories', title: 'Memories', description: 'What it holds' }],
};

function pageData(cells: PluginPageData['rows'][number]['cells']): PluginPageData {
  return {
    columns: [{ key: 'text', label: 'Memory' }],
    rows: [{ id: '1', cells }],
    total: 1, page: 1, pageSize: 25,
  };
}

function show(data: PluginPageData) {
  vi.spyOn(api, 'listPlugins').mockResolvedValue([plugin]);
  vi.spyOn(api, 'pluginPage').mockResolvedValue(data);
  render(
    <MemoryRouter initialEntries={['/plugins/rolling-memory/pages/memories']}>
      <Routes>
        <Route path="/plugins/:pluginId/pages/:pageId" element={<PluginPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('a long text cell in a plugin page', () => {
  it('shows the preview in the table and the whole memory in a dialog', async () => {
    show(pageData({
      text: {
        kind: 'text', text: FULL, preview: PREVIEW,
        mentions: { [MENTION]: 'Alice' },
      },
    }));

    // The table carries the preview only — the paragraph is what made it unreadable.
    expect(await screen.findByText(/argued about…/)).toBeTruthy();
    expect(screen.queryByText(/entirely unresolved/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/entirely unresolved/)).toBeTruthy();
    // The column label names the dialog, so it is not a generic "Details".
    expect(within(dialog).getByText('Memory')).toBeTruthy();
    // A mention reads as the person in the dialog too, not as raw markup.
    expect(within(dialog).getByText('@Alice')).toBeTruthy();
    expect(within(dialog).queryByText(new RegExp(MENTION))).toBeNull();
  });

  it('leaves a cell without a preview exactly as it was', async () => {
    show(pageData({ text: { kind: 'text', text: 'Short enough to read in place' } }));

    expect(await screen.findByText('Short enough to read in place')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });
});
