import { PDFDocument } from '@cantoo/pdf-lib';
import { RGB } from 'obsidian';

import { HighlightGeometryLib } from 'lib/highlights/geometry';
import { SelfWriteTracker } from 'lib/self-write';
import { FakeVault } from './vault';

export interface FakePluginOptions {
    author?: string;
    writeHighlightToFileOpacity?: number;
    pdfLinkColor?: string;
    pdfLinkBorder?: boolean;
    deferReloadOnSelfEdit?: boolean;
    cacheParsedPDFForEditing?: boolean;
    /** Colour returned by `domManager.getRgb`, which normally reads a CSS variable. */
    rgb?: RGB;
    /** Skim settings, which together form the skim cache's settings key. */
    skimModel?: string;
    skimDensityPercent?: number;
    skimReadingGoal?: string;
}

/**
 * A `PDFPlus`-shaped object holding only what the file-writing submodules read.
 *
 * Building the real plugin would pull in `main.ts` and with it the whole Obsidian
 * UI surface, so the submodules under test get a hand-made host instead. Anything
 * a test asserts on is set here explicitly rather than inherited from defaults.
 */
export function createFakePlugin(options: FakePluginOptions = {}) {
    const vault = new FakeVault();

    const plugin: any = {
        manifest: { name: 'PDF++', id: 'pdf-plus', version: '0.0.0-test', dir: '.obsidian/plugins/pdf-plus' },
        settings: {
            author: options.author ?? 'Test Author',
            skimModel: options.skimModel ?? 'test-model',
            skimDensityPercent: options.skimDensityPercent ?? 18,
            skimReadingGoal: options.skimReadingGoal ?? '',
            writeHighlightToFileOpacity: options.writeHighlightToFileOpacity ?? 0.2,
            pdfLinkColor: options.pdfLinkColor ?? '#04a802',
            pdfLinkBorder: options.pdfLinkBorder ?? false,
            deferReloadOnSelfEdit: options.deferReloadOnSelfEdit ?? true,
            cacheParsedPDFForEditing: options.cacheParsedPDFForEditing ?? true,
        },
        selfWrites: new SelfWriteTracker(),
        domManager: {
            getRgb: (_colorName?: string): RGB => options.rgb ?? { r: 255, g: 208, b: 0 },
        },
        app: { vault },
    };

    plugin.lib = {
        // Mirrors `PDFPlusLib.loadPdfLibDocument`. Kept here rather than imported
        // because `lib/index.ts` reaches into the whole plugin to construct itself.
        loadPdfLibDocument: async (file: any) => PDFDocument.load(await vault.readBinary(file)),
        loadPdfLibDocumentFromArrayBuffer: async (buffer: ArrayBuffer) => PDFDocument.load(buffer),
        highlight: {
            geometry: new HighlightGeometryLib(plugin),
        },
    };

    return { plugin, vault };
}
