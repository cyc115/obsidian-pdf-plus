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

        // Counting elements is not enough: a mark whose `background-color` fails to
        // parse is still in the DOM, still has a box, and is completely invisible.
        // So report what the mark actually paints, straight from the renderer.
        const markEl = child.containerEl.querySelector('.pdf-plus-pending-annotation');
        let mark = null;
        if (markEl) {
            const style = getComputedStyle(markEl);
            const box = markEl.getBoundingClientRect();
            mark = {
                backgroundColor: style.backgroundColor,
                borderBottom: style.borderBottomWidth + ' ' + style.borderBottomColor,
                opacity: style.opacity,
                visibility: style.visibility,
                display: style.display,
                width: Math.round(box.width),
                height: Math.round(box.height),
            };
        }

        return {
            childStamp: child.__e2eStamp ?? null,
            documentStamp: child.pdfViewer?.pdfLoadingTask?.__e2eStamp ?? null,
            pendingCount: child.pendingAnnotations?.size ?? -1,
            overlayCount: child.containerEl.querySelectorAll('.pdf-plus-pending-annotation').length,
            mark,
        };
    });
}

/**
 * The alpha a colour actually paints with, or 0 if the renderer discarded it.
 *
 * `getComputedStyle` returns the empty string or `rgba(0, 0, 0, 0)` for a declaration
 * the parser rejected, which is exactly what an invisible highlight looks like.
 */
function paintedAlpha(color: string | undefined): number {
    if (!color) return 0;
    const parts = color.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return 0;
    return parts.length >= 4 ? Number(parts[3]) : 1;
}

/**
 * Turn skim mode on with a fake model behind it, and wait for marks to appear.
 *
 * `start()` builds a real provider from the user's settings and would call a real
 * endpoint, so the provider is installed directly and `start()` is bypassed. The
 * quote comes from a text layer node, which is what the marks anchor against, so
 * the fake's answer is guaranteed to be findable on the page.
 */
async function startSkimWithFakeProvider() {
    await browser.executeObsidian(async ({ app }, id: string) => {
        const plugin: any = (app as any).plugins.plugins[id];
        const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
        const child = view.viewer.child;
        const skim = child.skim;

        skim.stop();
        if (child.file) await plugin.skimCache.clear(child.file);

        // A phrase that is definitely on page 1, kept clear of the line the highlight
        // tests select so the two features are not fighting over the same text.
        const nodes = child.getPage(1).div.querySelectorAll('.textLayerNode');
        let quote = '';
        for (let i = 2; i < nodes.length; i++) {
            const text = (nodes[i].textContent ?? '').trim();
            if (text.length > 20) { quote = text; break; }
        }

        const w = window as any;
        w.__skimCalls = 0;
        w.__skimQuote = quote;
        skim.provider = {
            pickSpans: async () => {
                w.__skimCalls++;
                return { gist: 'a test gist', spans: quote ? [{ quote, tier: 1 }] : [] };
            },
        };

        skim.results.clear();
        skim.states.clear();
        skim.active = true;
        skim.updateToolbarState();
        skim.analyzeAround(child.pdfViewer.pdfViewer?.currentPageNumber ?? 1);
    }, PLUGIN_ID);

    await browser.waitUntil(
        async () => await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
            return view.viewer.child.containerEl.querySelectorAll('.pdf-plus-skim-mark').length > 0;
        }),
        { timeout: 30000, interval: 250, timeoutMsg: 'skim marks never appeared' },
    );

    return await browser.executeObsidian(({ app }) => {
        const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
        return {
            markCount: view.viewer.child.containerEl.querySelectorAll('.pdf-plus-skim-mark').length,
            calls: (window as any).__skimCalls as number,
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
        // Report the app version from inside the running app. The reporter's header
        // echoes the requested `browserVersion`, so it still says 1.13.7 when
        // OBSIDIAN_APP_PATH loads a different app - which makes it easy to believe a
        // version was covered when it was not.
        const apiVersion = await browser.executeObsidian(({ obsidian }: any) => obsidian?.apiVersion ?? 'unknown');
        console.log(`Obsidian app actually under test: ${apiVersion}`);

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

    // The whole point of not reloading is that the reader sees the highlight anyway.
    // Without this, the suite is satisfied by a mark that is present and invisible -
    // which is worse than the reload it replaced, because the annotation is simply
    // missing until something forces a reload.
    it('paints the mark so the reader can actually see it', async function () {
        await highlightALine();
        await browser.pause(1000);

        const { mark } = await inspectViewer();
        expect(mark).not.toBe(null);

        // A real box, on screen, that paints a visible colour.
        expect(mark!.width).toBeGreaterThan(0);
        expect(mark!.height).toBeGreaterThan(0);
        expect(mark!.visibility).toBe('visible');
        expect(mark!.display).not.toBe('none');
        expect(Number(mark!.opacity)).toBeGreaterThan(0);
        expect(paintedAlpha(mark!.backgroundColor)).toBeGreaterThan(0);
    });

    // Skim marks are paid for per page, with real money, so a highlight must not
    // throw them away and buy them again. Both halves matter: the marks staying put
    // is what the reader sees, the call count is what they are billed for.
    it('highlighting neither clears the skim marks nor re-runs the model', async function () {
        const started = await startSkimWithFakeProvider();
        expect(started.markCount).toBeGreaterThan(0);
        expect(started.calls).toBeGreaterThan(0);

        // Watch every DOM mutation rather than sampling on a timer. Once the cache is
        // keyed on page text the re-analysis is an instant cache hit, so the marks can
        // be cleared and redrawn well inside a polling interval - a sampler simply does
        // not see the blink, and the test passes while the overlay still flickers.
        await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
            const child = view.viewer.child;
            const w = window as any;
            const count = () => child.containerEl.querySelectorAll('.pdf-plus-skim-mark').length;

            w.__skimMin = count();
            w.__skimObserver = new MutationObserver(() => {
                const n = count();
                if (n < w.__skimMin) w.__skimMin = n;
            });
            w.__skimObserver.observe(child.containerEl, { childList: true, subtree: true });
        });

        await highlightALine();
        // Outlast the self-write window and the few seconds the re-analysis took.
        await browser.pause(4000);

        const after = await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType('pdf')[0].view;
            const child = view.viewer.child;
            const w = window as any;
            w.__skimObserver.disconnect();
            return {
                lowestMarkCount: w.__skimMin,
                markCount: child.containerEl.querySelectorAll('.pdf-plus-skim-mark').length,
                calls: w.__skimCalls,
            };
        });

        // The overlay never blinked out.
        expect(after.lowestMarkCount).toBeGreaterThan(0);
        expect(after.markCount).toBeGreaterThan(0);
        // And nothing was bought a second time.
        expect(after.calls).toBe(started.calls);
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
