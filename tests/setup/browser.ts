/**
 * The bits of a browser jsdom does not implement but the app uses.
 *
 * `matchMedia` is the only one so far: `next-themes` asks it what the machine
 * prefers, and jsdom answers with a missing function rather than a query, which
 * takes down every test that renders the app rather than only the theme ones.
 * Reported as "no preference", which is what a machine with nothing configured
 * would say.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
