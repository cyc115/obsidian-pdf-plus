import { describe, expect, test } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { PdfLibIO } from 'lib/highlights/write-file/pdf-lib';
import { Rect } from 'typings';
import { createFakePlugin } from '../harness/plugin';
import { createTestPdfBytes } from '../harness/fixtures';

const RECT: Rect = [72, 680, 400, 700];

/**
 * These tests read back what PDF++ wrote using PDF.js - the same engine that
 * renders PDFs inside Obsidian.
 *
 * pdf-lib assertions only prove the bytes say what we meant; these prove a real
 * reader agrees. The annotation ID check matters most: PDF++ computes IDs itself
 * when writing, and every link from a note to an annotation depends on that ID
 * matching the one PDF.js reports at render time.
 */
async function annotationsFromBytes(bytes: Uint8Array, pageNumber: number) {
    const doc = await getDocument({
        data: new Uint8Array(bytes),
        // Node has no DOM; keep PDF.js off anything that needs one.
        isEvalSupported: false,
        useSystemFonts: false,
    }).promise;
    try {
        const page = await doc.getPage(pageNumber);
        return await page.getAnnotations();
    } finally {
        await doc.destroy();
    }
}

describe('PDF.js reads back what PDF++ writes', () => {
    test('a highlight is a real, addressable annotation', async () => {
        const { plugin, vault } = createFakePlugin({
            author: 'Mike Chen',
            writeHighlightToFileOpacity: 0.2,
            rgb: { r: 255, g: 208, b: 0 },
        });
        const file = vault.createBinaryFile('test.pdf', await createTestPdfBytes());
        const io = new PdfLibIO(plugin);

        const id = await io.addHighlightAnnotation(file, 1, [RECT], 'yellow', 'a note');

        const annotations = await annotationsFromBytes(vault.readBytes(file), 1);
        expect(annotations).toHaveLength(1);
        const annot = annotations[0];

        // The ID PDF++ returned is the one PDF.js uses to address the annotation.
        expect(annot.id).toBe(id);
        expect(annot.subtype).toBe('Highlight');
        expect(annot.contentsObj.str).toBe('a note');
        expect(annot.titleObj.str).toBe('Mike Chen');
        expect(annot.color).toEqual(new Uint8ClampedArray([255, 208, 0]));
        expect(annot.rect.map(Math.round)).toEqual([72, 680, 400, 700]);
        expect(annot.quadPoints).toBeTruthy();
    });

    test('an annotation deleted by PDF++ is gone for readers too', async () => {
        const { plugin, vault } = createFakePlugin();
        const file = vault.createBinaryFile('test.pdf', await createTestPdfBytes());
        const io = new PdfLibIO(plugin);

        const id = await io.addHighlightAnnotation(file, 1, [RECT]);
        expect(await annotationsFromBytes(vault.readBytes(file), 1)).toHaveLength(1);

        await io.deleteAnnotation(file, 1, id);

        expect(await annotationsFromBytes(vault.readBytes(file), 1)).toHaveLength(0);
    });

    test('the document survives repeated annotate-and-save cycles', async () => {
        const { plugin, vault } = createFakePlugin();
        const file = vault.createBinaryFile('test.pdf', await createTestPdfBytes({ pages: 3 }));
        const io = new PdfLibIO(plugin);

        for (let i = 0; i < 5; i++) {
            await io.addHighlightAnnotation(file, 1, [[72, 700 - i * 20, 400, 715 - i * 20]], undefined, `note ${i}`);
        }

        const doc = await getDocument({ data: new Uint8Array(vault.readBytes(file)), isEvalSupported: false }).promise;
        try {
            expect(doc.numPages).toBe(3);
            const annotations = await (await doc.getPage(1)).getAnnotations();
            expect(annotations).toHaveLength(5);
            expect(annotations.map((a: any) => a.contentsObj.str))
                .toEqual(['note 0', 'note 1', 'note 2', 'note 3', 'note 4']);
            // Page text must still be extractable - a corrupted save would lose it.
            const text = await (await doc.getPage(2)).getTextContent();
            expect(text.items.map((item: any) => item.str).join(' ')).toContain('quick brown fox');
        } finally {
            await doc.destroy();
        }
    });
});
