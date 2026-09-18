import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { PDFDocument, PDFDict, PDFName } from '@cantoo/pdf-lib';

const PLUGIN_ID = 'pdf-plus';
const PDF_PATH = 'sample.pdf';

/**
 * Exercises the highlight path inside a real Obsidian.
 *
 * What only this level can check: PDF++ reaches the no-reload behaviour by patching
 * `PDFView.onModify`, an Obsidian internal. If a future Obsidian renames it or calls
 * it differently, the patch silently stops applying and every highlight goes back to
 * flashing - with no failing unit test anywhere, because the units are all fine.
 *
 * Reloads are detected by stamping the `PDFViewerChild`: Obsidian builds a new child
 * when it reloads the document, so a surviving stamp means no reload happened. The
 * "reload still happens when the setting is off" test exists to prove the stamp
 * actually detects reloads, rather than always looking like success.
 */
async function setSettings(settings: Record<string, unknown>) {
    await browser.executeObsidian(async ({ app }, id: string, settings: Record<string, unknown>) => {
        const plugin = (app as any).plugins.plugins[id];
        Object.assign(plugin.settings, settings);
        await plugin.saveSettings();
    }, PLUGIN_ID, settings);
}

/**
 * Wait until page 1 is genuinely selectable.
 *
 * A `textLayer` object appears well before its spans are in the DOM, and PDF++ itself
 * refuses to annotate until `div.dataset.loaded` is set, so wait for both - otherwise
 * the first test of a run selects nothing and fails for reasons unrelated to the code.
 */
async function waitForRenderedPdf() {
    await browser.waitUntil(
        async () => await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType('pdf')[0]?.view;
            const child = view?.viewer?.child;
            if (!child?.pdfViewer?.pdfViewer) return false;

            const pageView = child.getPage(1);
            if (!pageView?.textLayer || !pageView.div.dataset.loaded) return false;

            const nodes = pageView.div.querySelectorAll('.textLayerNode');
            return nodes.length > 2 && !!nodes[1]?.textContent;
        }),
        { timeout: 60000, interval: 250, timeoutMsg: 'PDF never became selectable' },
    );
}

/**
 * Mark the currently loaded document.
 *
 * Measured against a real reload in Obsidian 1.13.7: reloading replaces the loading
 * task, the `PDFDocumentProxy`, and every `PDFPageView`, while the `PDFViewerChild`,
 * the `ObsidianViewer`, its event bus and the container element are all reused. So
 * the loading task is the signal, and the child is stamped only for diagnosis -
 * asserting on the child would pass even when the document was re-parsed.
 */
async function stampViewer() {
    await browser.executeObsidian(({ app }) => {
        const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
        const child = view.viewer.child;
        child.__e2eStamp = 'child';
        child.pdfViewer.pdfLoadingTask.__e2eStamp = 'document';
    });
}

/** Select a line of text on page 1 and highlight it, the way a reader would. */
async function highlightALine(lineIndex = 1) {
    return await browser.executeObsidian(async ({ app }, id: string, lineIndex: number) => {
        const plugin: any = (app as any).plugins.plugins[id];
        const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
        const child = view.viewer.child;

        const pageView = child.getPage(1);
        const textNodes = pageView.div.querySelectorAll('.textLayerNode');
        if (textNodes.length <= lineIndex) throw new Error(`text layer has ${textNodes.length} nodes`);

        // Select the text node inside, not the element: PDF++ derives the character
        // offsets from the selection's containers, and a real drag lands in text.
        const textNode = textNodes[lineIndex].firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
            throw new Error(`line ${lineIndex} has no text node`);
        }

        const selection = window.getSelection()!;
        selection.removeAllRanges();
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, textNode.textContent!.length);
        selection.addRange(range);

        // Read both before writing: PDF++ clears the selection once it has used it.
        const selectedText = selection.toString();
        const resolvedRange = plugin.lib.copyLink.getPageAndTextRangeFromSelection(selection);

        const result = await plugin.lib.highlight.writeFile.addTextMarkupAnnotationToSelection('Highlight');

        return {
            annotationID: result?.annotationID ?? null,
            rectCount: result?.rects?.length ?? -1,
            // Reported so a failure says whether the selection or the write broke.
            selectedText,
            resolvedRange: resolvedRange?.selection ?? null,
        };
    }, PLUGIN_ID, lineIndex);
}

/** State of the open viewer, read after the dust has settled. */
async function inspectViewer() {
    return await browser.executeObsidian(({ app }) => {
        const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
        const child = view.viewer.child;
        return {
            childStamp: child.__e2eStamp ?? null,
            documentStamp: child.pdfViewer?.pdfLoadingTask?.__e2eStamp ?? null,
            pendingCount: child.pendingAnnotations?.size ?? -1,
            overlayCount: child.containerEl.querySelectorAll('.pdf-plus-pending-annotation').length,
        };
    });
}

async function annotationsInFile(): Promise<PDFDict[]> {
    const bytes = await obsidianPage.readBinary(PDF_PATH);
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const annots = page.node.Annots();
    if (!annots) return [];
    return annots.asArray().map((ref) => page.node.context.lookup(ref, PDFDict));
}

/**
 * Restore the PDF to its unannotated state by copying `pristine.pdf` over it.
 *
 * Deliberately not `obsidianPage.resetVault()`: that replaces the file on disk, and
 * Obsidian then tracks a new `TFile` while the open view still holds the old one -
 * after which modifications no longer reach the view at all, and every reload
 * assertion here becomes meaningless. Writing through the vault keeps one file
 * identity, and one open tab, for the whole run.
 */
async function restorePristinePdf() {
    await browser.executeObsidian(async ({ app }, dest: string) => {
        const source = app.vault.getAbstractFileByPath('pristine.pdf') as any;
        const target = app.vault.getAbstractFileByPath(dest) as any;
        await app.vault.modifyBinary(target, await app.vault.readBinary(source));
    }, PDF_PATH);
}

describe('highlighting a PDF inside Obsidian', function () {
    before(async function () {
        await setSettings({
            enablePDFEdit: true,
            author: 'E2E',
            deferReloadOnSelfEdit: true,
            cacheParsedPDFForEditing: true,
        });

        // PDF++ patches Obsidian's PDF internals the first time a PDF is opened and
        // reloads the viewer to apply them. That one-off reload has nothing to do with
        // annotating, so absorb it here rather than inside the first test.
        await obsidianPage.openFile(PDF_PATH);
        await waitForRenderedPdf();
        await browser.pause(2000);
    });

    beforeEach(async function () {
        await setSettings({ deferReloadOnSelfEdit: true });

        // Restoring is itself an outside change, so it reloads the view. Let that
        // finish before a test stamps anything.
        await restorePristinePdf();
        await browser.pause(1500);
        await waitForRenderedPdf();
    });

    it('writes the annotation without reloading the document', async function () {
        await stampViewer();
        const written = await highlightALine();
        expect(written.selectedText.length).toBeGreaterThan(0);
        expect(written.resolvedRange).not.toBe(null);
        expect(written.rectCount).toBeGreaterThan(0);
        expect(written.annotationID).toMatch(/^\d+R$/);

        // Outlast the self-write window, so a reload would have happened by now.
        await browser.pause(2500);

        const viewer = await inspectViewer();
        expect(viewer.documentStamp).toBe('document');
        expect(viewer.pendingCount).toBe(1);
        expect(viewer.overlayCount).toBeGreaterThan(0);

        const annots = await annotationsInFile();
        expect(annots).toHaveLength(1);
        expect(annots[0].get(PDFName.of('Subtype'))).toBe(PDFName.of('Highlight'));
    });

    // Proves the stamp can actually go missing. Without this, every "no reload"
    // assertion above would pass just as happily if reloads were undetectable.
    it('a change from outside PDF++ does reload the document', async function () {
        await stampViewer();
        expect((await inspectViewer()).documentStamp).toBe('document');

        // A vault write PDF++ did not make - what another plugin editing the PDF
        // looks like from here.
        await browser.executeObsidian(async ({ app }, path: string) => {
            const file = app.vault.getAbstractFileByPath(path) as any;
            await app.vault.modifyBinary(file, await app.vault.readBinary(file));
        }, PDF_PATH);

        await browser.waitUntil(
            async () => (await inspectViewer()).documentStamp === null,
            { timeout: 20000, interval: 250, timeoutMsg: 'an external write did not reload the document' },
        );
    });

    it('still reloads when the setting is off', async function () {
        await setSettings({ deferReloadOnSelfEdit: false });
        await stampViewer();

        await highlightALine();
        await browser.waitUntil(
            async () => (await inspectViewer()).documentStamp === null,
            { timeout: 20000, interval: 250, timeoutMsg: 'the document was never re-opened' },
        );

        // The annotation is in the file either way; only the reload differs.
        expect(await annotationsInFile()).toHaveLength(1);
    });

    it('keeps drawing the mark after the page re-renders', async function () {
        await highlightALine();
        await browser.pause(1000);

        // Zooming tears down and rebuilds the page, which is where a naive overlay
        // would vanish.
        await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
            view.viewer.child.pdfViewer.pdfViewer.currentScaleValue = '1.5';
        });
        await browser.pause(2000);

        expect((await inspectViewer()).overlayCount).toBeGreaterThan(0);
    });

    it('several highlights in a row cost no reloads', async function () {
        await stampViewer();
        for (let i = 0; i < 3; i++) {
            await highlightALine(i + 1);
            await browser.pause(300);
        }
        await browser.pause(2500);

        const viewer = await inspectViewer();
        expect(viewer.documentStamp).toBe('document');
        expect(viewer.pendingCount).toBe(3);
        expect(await annotationsInFile()).toHaveLength(3);
    });
});
