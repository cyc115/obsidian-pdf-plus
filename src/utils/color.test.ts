import { describe, expect, test } from 'vitest';

import { parseComputedColorToRgb } from './color';

describe('parseComputedColorToRgb', () => {
    test('reads rgb() and rgba(), dropping alpha', () => {
        expect(parseComputedColorToRgb('rgba(255, 225, 0, 0.5)')).toEqual({ r: 255, g: 225, b: 0 });
        expect(parseComputedColorToRgb('rgb(12, 34, 56)')).toEqual({ r: 12, g: 34, b: 56 });
    });

    test('reads the space-separated and color(srgb) forms newer Chromium returns', () => {
        expect(parseComputedColorToRgb('rgb(12 34 56 / 0.5)')).toEqual({ r: 12, g: 34, b: 56 });
        expect(parseComputedColorToRgb('color(srgb 1 0.882353 0 / 0.25)')).toEqual({ r: 255, g: 225, b: 0 });
    });

    test('returns null for anything it cannot read', () => {
        expect(parseComputedColorToRgb('')).toBeNull();
        expect(parseComputedColorToRgb('var(--text-highlight-bg)')).toBeNull();
    });
});
