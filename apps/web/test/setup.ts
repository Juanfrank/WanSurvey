import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { initI18n } from '../src/i18n.js';

// jsdom has no scrolling; the router restores scroll positions.
window.scrollTo = () => {};

await initI18n('en');
afterEach(() => cleanup());
