import { afterEach, describe, expect, test, vi } from 'vitest';

import { PdfLibIO } from 'lib/highlights/write-file/pdf-lib';
import { SelfWriteTracker } from 'lib/self-write';
import { Rect } from 'typings';
import { createFakePlugin } from '../harness/plugin';
import { createTestPdfBytes } from '../harness/fixtures';

const RECT: Rect = [72, 680, 400, 700];
const SECOND_RECT: Rect = [72, 650, 320, 670];

async function setup(options?: Parameters<typeof createFakePlugin>[0]) {
    const { plugin, vault } = createFakePlugin(options);
    const file = vault.createBinaryFile('Attachments/test.pdf', await createTestPdfBytes());
    return { io: new PdfLibIO(plugin), plugin, vault, file };
}

describe('SelfWriteTracker', () => {
    afterEach(() => vi.useRealTimers());

    test('a marked path is attributed to us until the window passes', () => {
        vi.useFakeTimers();
        const tracker = new SelfWriteTracker();

        tracker.markWrite('a.pdf');
        expect(tracker.isSelfWrite('a.pdf')).toBe(true);

        vi.advanceTimersByTime(SelfWriteTracker.WINDOW_MS + 1);
        expect(tracker.isSelfWrite('a.pdf')).toBe(false);
    });

    test('one file being written says nothing about another', () => {
        const tracker = new SelfWriteTracker();
        tracker.markWrite('a.pdf');
        expect(tracker.isSelfWrite('b.pdf')).toBe(false);
    });

    test('a mark survives being checked repeatedly', () => {
        // Every open view asks independently, so checking must not consume the mark.
        const tracker = new SelfWriteTracker();
        tracker.markWrite('a.pdf');
        expect(tracker.isSelfWrite('a.pdf')).toBe(true);
        expect(tracker.isSelfWrite('a.pdf')).toBe(true);
    });

    test('forget releases the file so the next change reloads the view', () => {
        const tracker = new SelfWriteTracker();
        tracker.markWrite('a.pdf');
        tracker.forget('a.pdf');
        expect(tracker.isSelfWrite('a.pdf')).toBe(false);
    });
});

describe('which edits skip the viewer reload', () => {
    test('adding an annotation claims the write, so the view can skip reloading', async () => {
        const { io, plugin, file } = await setup();

        await io.addHighlightAnnotation(file, 1, [RECT]);

        expect(plugin.selfWrites.isSelfWrite(file.path)).toBe(true);
    });

    test.each([
        ['editing contents', async (io: PdfLibIO, file: any, id: string) => io.setAnnotationContents(file, 1, id, 'new')],
        ['recolouring', async (io: PdfLibIO, file: any, id: string) => io.setAnnotationColor(file, 1, id, { r: 1, g: 2, b: 3 })],
        ['deleting', async (io: PdfLibIO, file: any, id: string) => io.deleteAnnotation(file, 1, id)],
    ])('%s does not skip the reload - the rendered document would go stale', async (_label, act) => {
        const { io, plugin, file } = await setup();
        const id = await io.addHighlightAnnotation(file, 1, [RECT]);

        plugin.selfWrites.clear();
        await act(io, file, id);

        expect(plugin.selfWrites.isSelfWrite(file.path)).toBe(false);
    });

    test('with the setting off, nothing is claimed and every write reloads as before', async () => {
        const { io, plugin, file } = await setup({ deferReloadOnSelfEdit: false });

        await io.addHighlightAnnotation(file, 1, [RECT]);

        expect(plugin.selfWrites.isSelfWrite(file.path)).toBe(false);
    });
});

describe('keeping the PDF parsed between edits', () => {
    test('a run of highlights reads and parses the file once', async () => {
        const { io, vault, file } = await setup({ cacheParsedPDFForEditing: true });

        for (let i = 0; i < 5; i++) {
            await io.addHighlightAnnotation(file, 1, [[72, 700 - i * 20, 400, 715 - i * 20]]);
        }

        expect(vault.readCount).toBe(1);
        // All five still made it into the file.
        expect(vault.modifyEvents).toHaveLength(5);
    });

    test('without the cache, every edit re-reads the whole file', async () => {
        const { io, vault, file } = await setup({ cacheParsedPDFForEditing: false });

        for (let i = 0; i < 5; i++) {
            await io.addHighlightAnnotation(file, 1, [[72, 700 - i * 20, 400, 715 - i * 20]]);
        }

        expect(vault.readCount).toBe(5);
    });

    test('a change made outside PDF++ is picked up rather than served from cache', async () => {
        const { io, vault, file } = await setup({ cacheParsedPDFForEditing: true });
        await io.addHighlightAnnotation(file, 1, [RECT]);
        const readsAfterFirst = vault.readCount;

        // Something else rewrites the file - here, a fresh PDF with no annotations.
        await vault.modifyBinary(file, await createTestPdfBytes());
        io.invalidate(file.path);

        await io.addHighlightAnnotation(file, 1, [SECOND_RECT]);

        expect(vault.readCount).toBe(readsAfterFirst + 1);
        // The external content won, so only the newest annotation is present.
        const contents = await io.getAnnotationContents(file, 1, '99999R');
        expect(contents).toBeNull();
    });

    test('a different file is never served from another file cache', async () => {
        const { io, vault, file } = await setup({ cacheParsedPDFForEditing: true });
        const other = vault.createBinaryFile('Attachments/other.pdf', await createTestPdfBytes());

        await io.addHighlightAnnotation(file, 1, [RECT]);
        await io.addHighlightAnnotation(other, 1, [RECT]);

        expect(vault.readCount).toBe(2);
    });

    test('the cache does not lose edits: every annotation is in the saved bytes', async () => {
        const { io, vault, file } = await setup({ cacheParsedPDFForEditing: true });

        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
            ids.push(await io.addHighlightAnnotation(file, 1, [[72, 700 - i * 20, 400, 715 - i * 20]], undefined, `note ${i}`));
        }

        // Read back with the cache bypassed, so this checks the file and not our copy.
        io.invalidate();
        for (const [i, id] of ids.entries()) {
            expect(await io.getAnnotationContents(file, 1, id)).toBe(`note ${i}`);
        }
    });
});
