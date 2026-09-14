// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsPage from '../../src/client/routes/SettingsPage';
import { api } from '../../src/client/lib/api';
import { DEFAULT_SETTINGS, DUPLICATE_DISTANCE_MAX } from '../../src/shared/constants';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

function stubSettingsApi() {
  vi.spyOn(api, 'getSettings').mockResolvedValue({ ...DEFAULT_SETTINGS });
  vi.spyOn(api, 'listChannels').mockResolvedValue({ channels: [], botOnline: true });
  vi.spyOn(api, 'listControllers').mockResolvedValue([]);
  vi.spyOn(api, 'updateSettings').mockImplementation(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }));
}

describe('attachment size setting', () => {
  it('shows the default budget and saves 0 to disable text attachments', async () => {
    stubSettingsApi();
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

describe('duplicate fact distance', () => {
  it('is editable, bounded, and saved as the integer the server clamps', async () => {
    stubSettingsApi();
    render(<SettingsPage />);
    const input = await screen.findByRole('spinbutton', { name: 'Duplicate fact distance' });
    expect((input as HTMLInputElement).value).toBe(String(DEFAULT_SETTINGS.duplicateDistance));
    // Zero would make every fact a duplicate of nothing, so the floor is 1.
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe(String(DUPLICATE_DISTANCE_MAX));

    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ duplicateDistance: 40 }));
    expect((input as HTMLInputElement).value).toBe('40');
  });
});
