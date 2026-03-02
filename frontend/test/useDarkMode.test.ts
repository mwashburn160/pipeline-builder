/**
 * Tests for getInitialDark() lazy initializer in useDarkMode hook (Fix 19).
 *
 * The fix changed useDarkMode from useState(false) + useEffect to
 * useState(getInitialDark) so the correct theme is read synchronously
 * on first render, preventing a flash of wrong theme.
 *
 * Since the test environment is 'node', we mock browser globals
 * (window, localStorage, matchMedia) to test getInitialDark directly.
 */

// Mock React so the module can be imported in a node environment
const mockUseState = jest.fn();
const mockUseEffect = jest.fn();

jest.mock('react', () => ({
  useState: mockUseState,
  useEffect: mockUseEffect,
}));

import { getInitialDark } from '../src/hooks/useDarkMode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal localStorage mock */
function mockLocalStorage(store: Record<string, string> = {}) {
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
    key: jest.fn(),
    length: 0,
  };
}

/** Create a minimal matchMedia mock */
function mockMatchMedia(matches: boolean) {
  return jest.fn().mockReturnValue({
    matches,
    media: '',
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
}

// ---------------------------------------------------------------------------
// Tests for getInitialDark
// ---------------------------------------------------------------------------
describe('getInitialDark', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    // Restore window to its original value after each test
    if (originalWindow === undefined) {
      // @ts-ignore - needed for SSR test restoration
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  it('should return true when localStorage has theme = "dark"', () => {
    const storage = mockLocalStorage({ theme: 'dark' });
    (globalThis as any).window = {
      localStorage: storage,
      matchMedia: mockMatchMedia(false),
    };
    // Also expose localStorage at global scope (getInitialDark reads it directly)
    (globalThis as any).localStorage = storage;

    expect(getInitialDark()).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith('theme');
  });

  it('should return false when localStorage has theme = "light"', () => {
    const storage = mockLocalStorage({ theme: 'light' });
    (globalThis as any).window = {
      localStorage: storage,
      matchMedia: mockMatchMedia(true), // OS prefers dark, but localStorage wins
    };
    (globalThis as any).localStorage = storage;

    expect(getInitialDark()).toBe(false);
    expect(storage.getItem).toHaveBeenCalledWith('theme');
  });

  it('should return OS preference (true) when no localStorage value exists', () => {
    const storage = mockLocalStorage({}); // no 'theme' key
    const media = mockMatchMedia(true); // OS prefers dark
    (globalThis as any).window = {
      localStorage: storage,
      matchMedia: media,
    };
    (globalThis as any).localStorage = storage;

    expect(getInitialDark()).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith('theme');
    expect(media).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('should return OS preference (false) when no localStorage value and OS prefers light', () => {
    const storage = mockLocalStorage({});
    const media = mockMatchMedia(false); // OS prefers light
    (globalThis as any).window = {
      localStorage: storage,
      matchMedia: media,
    };
    (globalThis as any).localStorage = storage;

    expect(getInitialDark()).toBe(false);
    expect(media).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('should return false when window is undefined (SSR)', () => {
    // Simulate SSR environment by removing window
    // @ts-ignore - intentionally removing window for SSR test
    delete (globalThis as any).window;

    expect(getInitialDark()).toBe(false);
  });
});
