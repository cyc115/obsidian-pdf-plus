/**
 * Minimal browser globals for code paths that read CSS custom properties.
 *
 * The plugin reads theme values (e.g. `--radius-s`) straight off `document.body`.
 * A full DOM is not worth the dependency for file-level tests, so we provide just
 * enough for `getComputedStyle(document.body).getPropertyValue(...)` to return ''.
 */
const cssValues = new Map<string, string>();

if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = { body: {} };
}

if (typeof (globalThis as any).getComputedStyle === 'undefined') {
    (globalThis as any).getComputedStyle = () => ({
        getPropertyValue: (name: string) => cssValues.get(name) ?? '',
    });
}

/** Let a test pretend the theme defines a CSS variable. */
export function setCssVariable(name: string, value: string) {
    cssValues.set(name, value);
}
