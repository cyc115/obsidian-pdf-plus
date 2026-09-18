import { beforeEach, describe, expect, test } from 'vitest';
import { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from '@cantoo/pdf-lib';
import { Notice } from 'obsidian';

import { PdfLibIO } from 'lib/highlights/write-file/pdf-lib';
import { Rect } from 'typings';
import { createFakePlugin } from '../harness/plugin';
import { createTestPdfBytes } from '../harness/fixtures';
import { FakeVault } from '../harness/vault';

/** A selection rectangle in PDF user space: [left, bottom, right, top]. */
const RECT: Rect = [72, 680, 400, 700];
const SECOND_RECT: Rect = [72, 650, 320, 670];

async function setup(options?: Parameters<typeof createFakePlugin>[0]) {
    const { plugin, vault } = createFakePlugin(options);
    const file = vault.createBinaryFile('Attachments/test.pdf', await createTestPdfBytes());
    return { io: new PdfLibIO(plugin), plugin, vault, file };
}

/** Re-parse what is actually on "disk" - never assert against the in-memory doc. */
async function reopen(vault: FakeVault, file: any) {
    return await PDFDocument.load(vault.readBytes(file));
}

function annotsOf(doc: PDFDocument, pageNumber: number): PDFDict[] {
    const page = doc.getPage(pageNumber - 1);
    const annots = page.node.Annots();
    if (!annots) return [];
    return annots.asArray().map((ref) => page.node.context.lookup(ref, PDFDict));
}

function numbersOf(dict: PDFDict, key: string): number[] {
    const array = dict.get(PDFName.of(key));
    if (!(array instanceof PDFArray)) throw new Error(`${key} is not an array`);
    return array.asArray().map((n) => (n as PDFNumber).asNumber());
}

function textOf(dict: PDFDict, key: string): string | undefined {
    const value = dict.get(PDFName.of(key));
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
}

describe('writing text markup annotations into a PDF file', () => {
    beforeEach(() => {
        // Notices are collected globally in the stub; keep assertions independent.
        (Notice as any).messages.length = 0;
    });

    test('a highlight lands on the requested page with the expected dictionary', async () => {
        const { io, vault, file } = await setup({
            author: 'Mike Chen',
            writeHighlightToFileOpacity: 0.35,
            rgb: { r: 255, g: 208, b: 0 },
        });

        const id = await io.addHighlightAnnotation(file, 2, [RECT], 'yellow', 'my note');

        const doc = await reopen(vault, file);
        expect(annotsOf(doc, 1)).toHaveLength(0);

        const annots = annotsOf(doc, 2);
        expect(annots).toHaveLength(1);
        const annot = annots[0];

        expect(annot.get(PDFName.of('Type'))).toBe(PDFName.of('Annot'));
        expect(annot.get(PDFName.of('Subtype'))).toBe(PDFName.of('Highlight'));
        expect(numbersOf(annot, 'Rect')).toEqual([72, 680, 400, 700]);
        // "left-top, right-top, left-bottom, right-bottom" - the order real readers
        // expect, which is not the order the PDF spec states.
        expect(numbersOf(annot, 'QuadPoints')).toEqual([72, 700, 400, 700, 72, 680, 400, 680]);
        expect(numbersOf(annot, 'C')).toEqual([255 / 255, 208 / 255, 0 / 255]);
        expect((annot.get(PDFName.of('CA')) as PDFNumber).asNumber()).toBe(0.35);
        expect(textOf(annot, 'T')).toBe('Mike Chen');
        expect(textOf(annot, 'Contents')).toBe('my note');
        expect(textOf(annot, 'M')).toMatch(/^D:\d{14}/);

        // The returned ID must match PDF.js's `<objectNumber>R` form, because links
        // to annotations are resolved by looking this up in the rendered document.
        expect(id).toMatch(/^\d+R$/);
        const objectNumber = Number(id.slice(0, -1));
        expect(Number.isInteger(objectNumber)).toBe(true);
    });

    test('a multi-line selection becomes one annotation with quadpoints per line', async () => {
        const { io, vault, file } = await setup();

        await io.addHighlightAnnotation(file, 1, [RECT, SECOND_RECT]);

        const annots = annotsOf(await reopen(vault, file), 1);
        expect(annots).toHaveLength(1);
        // Rect is the bounding box of every line...
        expect(numbersOf(annots[0], 'Rect')).toEqual([72, 650, 400, 700]);
        // ...while QuadPoints keeps the lines separate: 8 numbers each.
        expect(numbersOf(annots[0], 'QuadPoints')).toHaveLength(16);
    });

    test.each(['Highlight', 'Underline', 'Squiggly', 'StrikeOut'] as const)(
        '%s is written with its own subtype, and only Highlight gets reduced opacity',
        async (subtype) => {
            const { io, vault, file } = await setup({ writeHighlightToFileOpacity: 0.2 });

            await io.addTextMarkupAnnotation(file, 1, [RECT], subtype);

            const annot = annotsOf(await reopen(vault, file), 1)[0];
            expect(annot.get(PDFName.of('Subtype'))).toBe(PDFName.of(subtype));
            expect((annot.get(PDFName.of('CA')) as PDFNumber).asNumber())
                .toBe(subtype === 'Highlight' ? 0.2 : 1.0);
        },
    );

    test('annotations accumulate instead of replacing each other', async () => {
        const { io, vault, file } = await setup();

        const first = await io.addHighlightAnnotation(file, 1, [RECT]);
        const second = await io.addHighlightAnnotation(file, 1, [SECOND_RECT]);

        expect(first).not.toBe(second);
        expect(annotsOf(await reopen(vault, file), 1)).toHaveLength(2);
    });

    test('writing refuses to run when no author name is configured', async () => {
        const { io, vault, file } = await setup({ author: '' });
        const before = vault.readBytes(file).byteLength;

        await expect(io.addHighlightAnnotation(file, 1, [RECT])).rejects.toThrow(/author name is not set/);
        expect(vault.readBytes(file).byteLength).toBe(before);
        expect(vault.modifyEvents).toHaveLength(0);
    });

    test('a link annotation points at an explicit destination on another page', async () => {
        const { io, vault, file } = await setup({ pdfLinkColor: '#ff0000', pdfLinkBorder: true });

        await io.addLinkAnnotation(file, 1, [RECT], [1, 'XYZ', 72, 700, null]);

        const doc = await reopen(vault, file);
        const annot = annotsOf(doc, 1)[0];
        expect(annot.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
        expect(numbersOf(annot, 'C')).toEqual([1, 0, 0]);
        expect(numbersOf(annot, 'Border')).toEqual([0, 0, 1]);

        const dest = annot.get(PDFName.of('Dest'));
        expect(dest).toBeInstanceOf(PDFArray);
        // First element must be a reference to page 2's dictionary.
        const destArray = (dest as PDFArray).asArray();
        expect(destArray[0]).toBe(doc.getPage(1).ref);
    });
});

describe('editing and deleting existing annotations', () => {
    test('contents, colour and opacity round-trip through the file', async () => {
        const { io, vault, file } = await setup();
        const id = await io.addHighlightAnnotation(file, 1, [RECT], undefined, 'original');

        expect(await io.getAnnotationContents(file, 1, id)).toBe('original');

        await io.setAnnotationContents(file, 1, id, 'edited ✎ with unicode');
        await io.setAnnotationColor(file, 1, id, { r: 0, g: 128, b: 255 });
        await io.setAnnotationOpacity(file, 1, id, 0.75);

        expect(await io.getAnnotationContents(file, 1, id)).toBe('edited ✎ with unicode');
        expect(await io.getAnnotationColor(file, 1, id)).toEqual({ r: 0, g: 128, b: 255 });
        expect(await io.getAnnotationOpacity(file, 1, id)).toBe(0.75);

        // The ID must survive edits - links in notes point at it.
        const annots = annotsOf(await reopen(vault, file), 1);
        expect(annots).toHaveLength(1);
    });

    test('deleting removes only the targeted annotation', async () => {
        const { io, vault, file } = await setup();
        const first = await io.addHighlightAnnotation(file, 1, [RECT]);
        const second = await io.addHighlightAnnotation(file, 1, [SECOND_RECT]);

        await io.deleteAnnotation(file, 1, first);

        const annots = annotsOf(await reopen(vault, file), 1);
        expect(annots).toHaveLength(1);
        expect(await io.getAnnotationContents(file, 1, second)).not.toBeNull();
        expect(await io.getAnnotationContents(file, 1, first)).toBeNull();
    });

    test('reading an unknown annotation ID is a miss, not a crash', async () => {
        const { io, file } = await setup();
        expect(await io.getAnnotationContents(file, 1, '99999R')).toBeNull();
        expect(await io.getAnnotationColor(file, 1, '99999R')).toBeNull();
    });
});

describe('file I/O cost of a single annotation', () => {
    test('each annotation rewrites the whole file and fires one modify event', async () => {
        const { io, vault, file } = await setup();

        await io.addHighlightAnnotation(file, 1, [RECT]);
        expect(vault.modifyEvents).toHaveLength(1);

        await io.addHighlightAnnotation(file, 1, [SECOND_RECT]);
        expect(vault.modifyEvents).toHaveLength(2);

        // Whether each of these costs the reader a full-document reload is decided
        // separately - see reload-suppression.test.ts.
        expect(vault.modifyEvents.every((f) => f.path === file.path)).toBe(true);
    });

    test('an edit that changes nothing still rewrites the file', async () => {
        const { io, vault, file } = await setup();
        const id = await io.addHighlightAnnotation(file, 1, [RECT], undefined, 'same');
        const writesAfterAdd = vault.modifyEvents.length;

        await io.setAnnotationContents(file, 1, id, 'same');

        expect(vault.modifyEvents.length).toBe(writesAfterAdd + 1);
    });
});
