// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import FactsSearchPage from '../../src/client/routes/FactsSearchPage';
import { api } from '../../src/client/lib/api';
import type { FactWithSources } from '../../src/shared/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const fact = (id: string): FactWithSources => ({
  id, text: `Fact ${id}`, distance: null, sourceMessages: [], mentionNames: {},
  metadata: { channelId: 'channel', guildId: 'guild', authorIds: [], messageIds: [], referencedFactIds: [], source: 'auto', timePeriodStart: 1, timePeriodEnd: 1, createdAt: 1 },
});

describe('fact browsing after deletion', () => {
  it('moves back to the preceding page after deleting the only fact on the last page', async () => {
    let deleted = false;
    vi.spyOn(api, 'factAuthors').mockResolvedValue([]);
    vi.spyOn(api, 'listFacts').mockImplementation(async ({ page = 1 } = {}) => ({
      facts: page === 1 ? [fact('first')] : deleted ? [] : [fact('last')],
      total: deleted ? 20 : 21, page, pageSize: 20,
    }));
    vi.spyOn(api, 'deleteFact').mockImplementation(async (id) => { deleted = true; return { id }; });
    render(<FactsSearchPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
    expect(await screen.findByText('Fact first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Fact last')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete fact' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText('Fact first')).toBeTruthy();
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    expect(screen.queryByText('No facts have been learned yet.')).toBeNull();
    expect(api.deleteFact).toHaveBeenCalledWith('last');
  });
});
