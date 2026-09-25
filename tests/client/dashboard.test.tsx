// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DashboardPage from '../../src/client/routes/DashboardPage';
import { api } from '../../src/client/lib/api';
import type { DashboardStats, ReplyLogEntry } from '../../src/shared/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

const SNOWFLAKE = '500000000000000001';

const reply = (userName: string): ReplyLogEntry => ({
  id: 1,
  guildId: 'guild',
  channelId: 'channel',
  taggedMessageId: '10',
  replyMessageId: '11',
  userId: SNOWFLAKE,
  userName,
  content: 'A reply',
  factIdsUsed: [],
  createdAt: 1_700_000_000_000,
  jumpLink: null,
});

function stubDashboard(latestReplies: ReplyLogEntry[]) {
  const stats: DashboardStats = { totalFacts: 0, totalMessagesReferenced: 0, totalReplies: 1, latestReplies };
  vi.spyOn(api, 'stats').mockResolvedValue(stats);
  vi.spyOn(api, 'aiUsage').mockResolvedValue({
    day: { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
    week: { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
    byTask: [], byModel: [], byProvider: [],
  });
}

describe('the latest replies table', () => {
  it('shows who tagged the bot by name rather than by snowflake', async () => {
    stubDashboard([reply('Alice')]);
    render(<DashboardPage />);
    expect(await screen.findByText('Alice')).not.toBeNull();
    expect(screen.queryByText(SNOWFLAKE)).toBeNull();
  });

  // The server resolves the name and falls back to the id when neither Discord
  // nor the message cache can place somebody; the column must then show that id
  // rather than an empty cell.
  it('shows the id when nobody could be named', async () => {
    stubDashboard([reply(SNOWFLAKE)]);
    render(<DashboardPage />);
    expect(await screen.findByText(SNOWFLAKE)).not.toBeNull();
  });
});
