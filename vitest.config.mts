import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Top-level modules under `src/`. The plugin imports these as bare specifiers
 * (e.g. `from 'utils'`), which esbuild resolves through the `baseUrl` in
 * tsconfig.json. Vite does not read `baseUrl`, so we mirror it here.
 */
const SRC_ROOTS = [
    'auto-copy', 'backlink-visualizer', 'bib', 'color-palette', 'context-menu',
    'dom-manager', 'drag', 'lib', 'main', 'modals', 'patchers', 'pdf-backlink',
    'pdf-cropped-embed', 'pdfjs-enums', 'post-process', 'settings', 'skim',
    'template', 'toolbar', 'typings', 'user-script', 'utils', 'vim',
];

export default defineConfig({
    resolve: {
        alias: [
            // `obsidian` ships types only - no runtime. Tests get a hand-written stub.
            { find: /^obsidian$/, replacement: path.resolve(import.meta.dirname, 'tests/stubs/obsidian.ts') },
            { find: new RegExp(`^(${SRC_ROOTS.join('|')})(/.*)?$`), replacement: path.resolve(import.meta.dirname, 'src') + '/$1$2' },
        ],
    },
    test: {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        setupFiles: ['tests/setup.ts'],
    },
});
