/*
 * Landing page behaviour, and only what the markup asks for:
 * 1. the theme toggle, hidden until this script can make it work;
 * 2. the hero gate demo, whose buttons change that picture and nothing else.
 */

type Theme = 'light' | 'dark';

const STORE_KEY = 'switchyard-theme';
const THEME_COLOR: Record<Theme, string> = { dark: '#0c0f12', light: '#e3e8ec' };
const root = document.documentElement;
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function store(theme: Theme): void {
  try {
    localStorage.setItem(STORE_KEY, theme);
  } catch {
    // Storage can be blocked; the toggle still works for this visit.
  }
}

function currentTheme(): Theme {
  const set = root.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return prefersLight.matches ? 'light' : 'dark';
}

function describe(button: HTMLButtonElement): void {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  button.setAttribute('aria-label', `Switch to ${next} theme`);
  button.title = `Switch to ${next} theme`;
}

function applyTheme(theme: Theme): void {
  root.dataset.theme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLOR[theme];
  }
}

function setUpThemeToggle(): void {
  const button = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (!button) return;
  const stored = readStored();
  if (stored) applyTheme(stored);
  describe(button);
  button.hidden = false;
  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store(next);
    describe(button);
  });
  prefersLight.addEventListener('change', () => describe(button));
}

function setUpGateDemo(): void {
  const run = document.querySelector<HTMLElement>('[data-run]');
  const state = run?.querySelector<HTMLElement>('[data-run-state]');
  const lamp = run?.querySelector<HTMLElement>('[data-run-lamp]');
  const says = run?.querySelector<HTMLElement>('[data-run-says]');
  if (!run || !state || !lamp || !says) return;

  const buttons = [...run.querySelectorAll<HTMLButtonElement>('button[data-verdict]')];
  const waiting = {
    state: state.textContent ?? '',
    lamp: lamp.dataset.state ?? 'caution',
    says: says.textContent ?? '',
  };

  // Pressing the pressed button again puts the gate back to waiting.
  const show = (chosen: HTMLButtonElement | null): void => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button === chosen));
    run.dataset.run = chosen?.dataset.verdict ?? 'waiting';
    state.textContent = chosen?.dataset.stateLabel ?? waiting.state;
    lamp.dataset.state = chosen?.dataset.lamp ?? waiting.lamp;
    says.textContent = chosen?.dataset.says ?? waiting.says;
  };

  for (const button of buttons) {
    button.disabled = false;
    button.addEventListener('click', () => {
      show(button.getAttribute('aria-pressed') === 'true' ? null : button);
    });
  }
}

setUpThemeToggle();
setUpGateDemo();
