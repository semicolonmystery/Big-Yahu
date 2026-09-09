// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../src/client/App';

vi.mock('../../src/client/components/ui/sonner', () => ({ Toaster: () => null }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const signedOut = { success: true, data: { hasAdmin: true, authenticated: false, username: null } };

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(cleanup);

describe('admin authentication recovery', () => {
  it('shows initial network failure and recovers with Try again', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(json(signedOut));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Network unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns to login when a protected request finds an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/status') return json({ success: true, data: { hasAdmin: true, authenticated: true, username: 'admin' } });
      if (url === '/api/stats') return json({ success: false, error: 'Not authenticated' }, 401);
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    expect(await screen.findByText('Your session has expired. Please sign in again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });

  it('keeps a wrong-password 401 as a login form error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/status') return json(signedOut);
      if (url === '/api/auth/login') return json({ success: false, error: 'Incorrect username or password' }, 401);
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect username or password')).toBeTruthy();
    expect(screen.queryByText('Your session has expired. Please sign in again.')).toBeNull();
  });
});
