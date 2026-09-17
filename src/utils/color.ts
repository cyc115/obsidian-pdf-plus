import { HexString, RGB } from 'obsidian';


export function isHexString(color: string) {
    // It's actually /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i
    // but it will be overkill
    return color.length === 7 && color.startsWith('#');
}

// Thanks https://stackoverflow.com/a/5624139
export function hexToRgb(hexColor: HexString) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

// Thanks https://stackoverflow.com/a/5624139
export function rgbToHex(rgb: RGB) {
    const { r, g, b } = rgb;
    return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}

export function rgbStringToObject(rgbString: string): RGB {
    const [r, g, b] = rgbString // "R, G, B"
        .split(',')
        .map((s) => parseInt(s.trim())); // [R, G, B];
    return { r, g, b };
}

/**
 * Read a computed CSS color, as `getComputedStyle` reports it, into its RGB channels (alpha is dropped).
 * Handles `rgb(r, g, b)`, `rgba(r, g, b, a)`, `rgb(r g b / a)` and `color(srgb r g b / a)`.
 */
export function parseComputedColorToRgb(color: string): RGB | null {
    const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color.trim());
    if (rgbMatch) {
        const [r, g, b] = rgbMatch.slice(1, 4).map((s) => Math.round(parseFloat(s)));
        return { r, g, b };
    }
    const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(color.trim());
    if (srgbMatch) {
        const [r, g, b] = srgbMatch.slice(1, 4).map((s) => Math.round(parseFloat(s) * 255));
        return { r, g, b };
    }
    return null;
}

/**
 * Obsidian's text highlight color. Obsidian 1.14 dropped `--text-highlight-bg-rgb` and kept only
 * `--text-highlight-bg`, so resolve the latter through a probe element when the former is missing.
 */
export function getObsidianDefaultHighlightColorRGB(): RGB | null {
    const style = getComputedStyle(document.body);
    const legacy = style.getPropertyValue('--text-highlight-bg-rgb').trim();
    if (legacy) return rgbStringToObject(legacy);

    if (!style.getPropertyValue('--text-highlight-bg').trim()) return null;
    const probe = document.body.createDiv();
    probe.style.color = 'var(--text-highlight-bg)';
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return parseComputedColorToRgb(computed);
}

export function getBorderRadius() {
    const cssValue = getComputedStyle(document.body).getPropertyValue('--radius-s');
    if (cssValue.endsWith('px')) {
        const px = parseInt(cssValue.slice(0, -2));
        if (!isNaN(px)) return px;
    }
    return 0;
}
