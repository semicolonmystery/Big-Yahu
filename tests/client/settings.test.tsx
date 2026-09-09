// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsPage from '../../src/client/routes/SettingsPage';
import { api } from '../../src/client/lib/api';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

describe('attachment size setting', () => {
  it('shows the default budget and saves 0 to disable text attachments', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({ ...DEFAULT_SETTINGS });
    vi.spyOn(api, 'listModels').mockResolvedValue([]);
    vi.spyOn(api, 'listChannels').mockResolvedValue({ channels: [], botOnline: true });
    vi.spyOn(api, 'listControllers').mockResolvedValue([]);
    vi.spyOn(api, 'updateSettings').mockImplementation(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }));
    render(<SettingsPage />);
    const input = await screen.findByRole('spinbutton', { name: 'Maximum message.txt size (KiB)' });
    expect((input as HTMLInputElement).value).toBe('16');
    expect(input.getAttribute('min')).toBe('0');
    expect(input.getAttribute('max')).toBe('64');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ textAttachmentMaxKb: 0 }));
    expect((input as HTMLInputElement).value).toBe('0');
  });
});
