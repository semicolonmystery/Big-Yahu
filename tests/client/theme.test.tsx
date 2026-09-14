// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'next-themes';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeToggle } from '../../src/client/components/ThemeToggle';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  localStorage.clear();
});

const withProvider = () => render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <ThemeToggle />
  </ThemeProvider>,
);

describe('choosing a theme', () => {
  it('offers system, light and dark, defaulting to system', async () => {
    withProvider();
    screen.getByRole('button', { name: 'Theme' }).click();
    for (const label of ['System', 'Light', 'Dark']) {
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
    }
    expect(localStorage.getItem('theme')).toBeNull();
  });

  // The stylesheet's dark variant is written against `.dark`, so the class on
  // the root element is the whole mechanism — not a data attribute.
  it('puts the class the stylesheet is written against on the root, and remembers it', async () => {
    withProvider();
    screen.getByRole('button', { name: 'Theme' }).click();
    await waitFor(() => expect(screen.getByText('Dark')).toBeTruthy());
    screen.getByText('Dark').click();

    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('goes back to light without leaving the dark class behind', async () => {
    withProvider();
    screen.getByRole('button', { name: 'Theme' }).click();
    await waitFor(() => expect(screen.getByText('Dark')).toBeTruthy());
    screen.getByText('Dark').click();
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));

    screen.getByRole('button', { name: 'Theme' }).click();
    await waitFor(() => expect(screen.getByText('Light')).toBeTruthy());
    screen.getByText('Light').click();
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(false));
  });
});
