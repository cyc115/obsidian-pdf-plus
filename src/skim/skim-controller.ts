import { Notice, TFile } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { PageText } from 'lib/text/page-text';
import { PDFPageView, PDFViewerChild, TextContentItem } from 'typings';
import { getTextLayerInfo } from 'utils';
import { createSkimProvider } from './llm';
import { isSectionHeading } from './prompt';
import { AnchoredSpan, SkimError, SkimPageResult, SkimProvider } from './types';
import { SkimCache } from './skim-cache';

const LAYER_CLASS = 'pdf-plus-skim-layer';
const MARK_CLASS = 'pdf-plus-skim-mark';


type PageState = 'idle' | 'working' | 'ready' | 'error';

/**
 * Drives skim mode for one PDF viewer.
 *
 * The pipeline per page: take the page's text, ask a model which phrases matter, find those
 * phrases in the text layer, turn each into rectangles, and draw them in a layer of their own.
 * Nothing is written to the PDF or to any note.
 */
export class SkimController extends PDFPlusComponent {
    private active = false;
    private provider: SkimProvider | null = null;
    private readonly results = new Map<number, SkimPageResult>();
    private readonly states = new Map<number, PageState>();
    private readonly inFlight = new Set<number>();
    private queue: number[] = [];
    private running = 0;
    private lastGist = '';
    private notifiedError = false;

    constructor(plugin: PDFPlus, private readonly child: PDFViewerChild, readonly cache: SkimCache) {
        super(plugin);
    }

    get file(): TFile | null {
        return this.child.file;
    }

    get isActive(): boolean {
        return this.active;
    }

    onload() {
        // Pages render lazily and re-render on zoom, so marks are drawn from the text layer event
        // rather than once at analysis time.
        this.lib.onTextLayerReady(this.child.pdfViewer, this, (pageNumber) => {
            if (!this.active) return;
            this.draw(pageNumber);
            if (!this.results.has(pageNumber) && this.states.get(pageNumber) !== 'error') {
                this.enqueue(pageNumber);
            }
        });

        this.lib.registerPDFEvent('pagechanging', this.child.pdfViewer.eventBus, this, (data) => {
            if (this.active) this.analyzeAround(data.pageNumber);
        });

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file === this.file) this.reset();
        }));
    }

    onunload() {
        this.clearAllMarks();
    }

    toggle(): boolean {
        this.active ? this.stop() : this.start();
        return this.active;
    }

    start() {
        if (this.active) return;
        try {
            this.provider = createSkimProvider(this.settings);
        } catch (error) {
            this.reportError(error);
            return;
        }
        this.active = true;
        this.notifiedError = false;
        this.updateToolbarState();
        // Pages analyzed before the last toggle already have results: draw them straight away.
        for (const pageNumber of this.results.keys()) this.draw(pageNumber);
        this.analyzeAround(this.child.pdfViewer.pdfViewer?.currentPageNumber ?? 1);
    }

    stop() {
        this.active = false;
        this.queue = [];
        this.clearAllMarks();
        this.updateToolbarState();
    }

    /** Forget every result for this document, on disk too, and analyze the current page again. */
    async clearCacheAndReanalyze() {
        const file = this.file;
        this.results.clear();
        this.states.clear();
        this.lastGist = '';
        this.clearAllMarks();
        if (file) await this.cache.clear(file);
        if (this.active) this.analyzeAround(this.child.pdfViewer.pdfViewer?.currentPageNumber ?? 1);
    }

    /** Drop in-memory results, keeping the cache on disk (used when the PDF changes on disk). */
    private reset() {
        this.results.clear();
        this.states.clear();
        this.lastGist = '';
        this.clearAllMarks();
        if (this.active) this.analyzeAround(this.child.pdfViewer.pdfViewer?.currentPageNumber ?? 1);
    }

    private analyzeAround(pageNumber: number) {
        this.enqueue(pageNumber);
        // Look ahead so that turning the page shows marks immediately.
        const ahead = this.settings.skimPagesAhead;
        const total = this.child.pdfViewer.pdfViewer?.pagesCount ?? pageNumber;
        for (let i = 1; i <= ahead; i++) {
            if (pageNumber + i <= total) this.enqueue(pageNumber + i);
        }
    }

    private enqueue(pageNumber: number) {
        if (!this.active) return;
        if (this.results.has(pageNumber) || this.inFlight.has(pageNumber)) return;
        if (this.states.get(pageNumber) === 'error') return;
        if (!this.queue.includes(pageNumber)) this.queue.push(pageNumber);
        this.pump();
    }

    private pump() {
        while (this.running < 2 && this.queue.length) {
            const pageNumber = this.queue.shift()!;
            if (this.results.has(pageNumber) || this.inFlight.has(pageNumber)) continue;
            this.running++;
            this.inFlight.add(pageNumber);
            this.analyze(pageNumber)
                .catch((error) => this.reportError(error, pageNumber))
                .finally(() => {
                    this.running--;
                    this.inFlight.delete(pageNumber);
                    this.pump();
                });
        }
    }

    private async analyze(pageNumber: number) {
        const file = this.file;
        const doc = this.child.pdfViewer.pdfViewer?.pdfDocument;
        if (!file || !doc || !this.provider) return;

        this.setState(pageNumber, 'working');

        await this.cache.load(file);
        const cached = this.cache.get(file, pageNumber);
        if (cached) {
            this.results.set(pageNumber, cached);
            this.setState(pageNumber, 'ready');
            this.draw(pageNumber);
            return;
        }

        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = PageText.fromItems(content.items as TextContentItem[]);
        if (pageText.countWords() < 20) {
            // A page with almost no text, such as a full-page figure. Nothing to mark.
            this.results.set(pageNumber, { gist: '', spans: [] });
            this.setState(pageNumber, 'ready');
            return;
        }

        const result = await this.provider.pickSpans({
            pageText: pageText.text,
            pageLabel: this.child.getPage(pageNumber)?.pageLabel ?? String(pageNumber),
            title: file.basename,
            heading: '',
            previousGist: this.lastGist,
            readingGoal: this.settings.skimReadingGoal,
            densityPercent: this.settings.skimDensityPercent,
        });

        this.lastGist = result.gist;
        this.results.set(pageNumber, result);
        this.setState(pageNumber, 'ready');
        await this.cache.set(file, pageNumber, result);
        this.draw(pageNumber);
    }

    /**
     * Find each phrase in the rendered text layer and draw it.
     *
     * Anchoring happens here rather than at analysis time because text layer positions come
     * from the PDF.js build Obsidian ships, while the cache holds only quotes.
     */
    private draw(pageNumber: number) {
        const result = this.results.get(pageNumber);
        const pageView = this.child.getPage(pageNumber);
        if (!result || !pageView?.textLayer) return;

        const textLayerInfo = getTextLayerInfo(pageView.textLayer);
        if (!textLayerInfo?.textContentItems?.length) return;

        this.clearMarks(pageView);

        const pageText = PageText.fromItems(textLayerInfo.textContentItems);
        const anchored = this.anchor(pageText, result);
        const kept = this.trimToDensity(anchored, pageText.countWords());

        for (const span of kept) {
            const rects = this.lib.highlight.geometry.computeMergedHighlightRects(
                textLayerInfo,
                span.range.beginIndex, span.range.beginOffset,
                span.range.endIndex, span.range.endOffset,
            );
            for (const { rect, indices } of rects) {
                const rectEl = this.lib.highlight.viewer.placeRectInPage(rect, pageView, {
                    layerClass: LAYER_CLASS, elClass: MARK_CLASS,
                });
                rectEl.dataset.tier = String(span.tier);
                rectEl.setAttribute('aria-label', 'Marked by AI');
                // Padding is set in em so it scales with the text, as backlink highlights do.
                const textDiv = textLayerInfo.textDivs[indices[0]];
                if (textDiv) rectEl.setCssStyles({ fontSize: textDiv.style.fontSize });
            }
        }
    }

    private anchor(pageText: PageText, result: SkimPageResult): AnchoredSpan[] {
        const anchored: AnchoredSpan[] = [];
        let searchFrom = 0;
        let dropped = 0;

        for (const span of result.spans) {
            if (isSectionHeading(span.quote)) continue;

            const hit = pageText.findQuote(span.quote, searchFrom);
            if (!hit) {
                // The model paraphrased. Drop it rather than mark the wrong words.
                dropped++;
                continue;
            }
            searchFrom = hit.to;
            anchored.push({ ...span, range: hit.range, length: hit.to - hit.from });
        }

        if (dropped) {
            console.debug(`PDF++: dropped ${dropped} skim phrase(s) that were not on the page verbatim`);
        }
        return anchored;
    }

    /**
     * Keep the page inside the density target.
     *
     * Models ignore a density instruction in the prompt, so the limit is applied here:
     * tier 2 phrases go first, then the longest, until the page is under budget.
     */
    private trimToDensity(spans: AnchoredSpan[], pageWords: number): AnchoredSpan[] {
        if (!spans.length || pageWords <= 0) return spans;

        const budget = Math.max(1, Math.round(pageWords * this.settings.skimDensityPercent / 100));
        const wordsOf = (span: AnchoredSpan) => span.quote.trim().split(/\s+/).length;

        const ordered = [...spans].sort((a, b) => a.tier - b.tier || wordsOf(a) - wordsOf(b));
        const kept: AnchoredSpan[] = [];
        let used = 0;
        for (const span of ordered) {
            const words = wordsOf(span);
            if (used + words > budget && kept.length) continue;
            kept.push(span);
            used += words;
        }
        // Draw in reading order so the DOM matches the page.
        return kept.sort((a, b) => a.range.beginIndex - b.range.beginIndex || a.range.beginOffset - b.range.beginOffset);
    }

    private clearMarks(pageView: PDFPageView) {
        pageView.div.querySelectorAll(`.${LAYER_CLASS} .${MARK_CLASS}`).forEach((el) => el.remove());
    }

    private clearAllMarks() {
        this.child.containerEl
            .querySelectorAll(`.${LAYER_CLASS} .${MARK_CLASS}`)
            .forEach((el) => el.remove());
    }

    private setState(pageNumber: number, state: PageState) {
        this.states.set(pageNumber, state);
        this.updateToolbarState();
    }

    /** CSS hooks so the viewer can show that skim mode is on, and that a page is being analyzed. */
    private updateToolbarState() {
        this.child.containerEl.toggleClass('pdf-plus-skim-active', this.active);
        this.child.containerEl.toggleClass('pdf-plus-skim-loading', this.active && this.running > 0);
    }

    private reportError(error: unknown, pageNumber?: number) {
        if (typeof pageNumber === 'number') this.setState(pageNumber, 'error');

        const skimError = error instanceof SkimError ? error : null;
        const message = skimError?.message ?? (error instanceof Error ? error.message : String(error));
        console.error('PDF++: skim highlights failed', error);

        // One notice per session per viewer: a failing key would otherwise fire on every page.
        if (this.notifiedError) return;
        this.notifiedError = true;
        const hint = skimError?.hint ? `\n${skimError.hint}` : '';
        new Notice(`${this.plugin.manifest.name}: skim highlights could not run.\n${message}${hint}`, 8000);
    }
}
