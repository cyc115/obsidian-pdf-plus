import { Component, RGB } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { PDFPageView, PDFViewerChild, Rect } from 'typings';
import { TextMarkupAnnotationSubtype } from './write-file';

const LAYER_CLASS = 'pdf-plus-pending-annotation-layer';
const MARK_CLASS = 'pdf-plus-pending-annotation';

/** An annotation written to the file but not yet present in the rendered document. */
export interface PendingAnnotation {
    id: string;
    /** 1-based. */
    page: number;
    rects: Rect[];
    subtype: TextMarkupAnnotationSubtype;
    rgb: RGB;
    opacity: number;
}

/**
 * Shows annotations that are already in the file but that PDF.js has not parsed yet.
 *
 * When PDF++ writes an annotation it suppresses the viewer reload Obsidian would
 * otherwise do (see `SelfWriteTracker`), which means the rendered document is now
 * one annotation behind the file. This layer closes that gap by drawing the new
 * mark itself, so the highlight appears instantly and without a reload.
 *
 * The marks are a stand-in, not the real thing: PDF.js knows nothing about them,
 * so clicking one *materializes* it - reloads the document for real, then opens the
 * genuine annotation popup. The cost of the reload is paid once, when the user
 * actually asks for it, instead of on every highlight.
 */
export class PendingAnnotationLayer extends PDFPlusComponent {
    private readonly pending = new Map<string, PendingAnnotation>();

    constructor(plugin: PDFPlus, private readonly child: PDFViewerChild) {
        super(plugin);
    }

    onload() {
        // Pages render lazily and re-render on zoom, so marks are redrawn from the
        // layer event rather than only at the moment they are added.
        this.lib.onTextLayerReady(this.child.pdfViewer, this, (pageNumber, pageView) => {
            this.drawPage(pageNumber, pageView);
        });
    }

    onunload() {
        this.clear();
    }

    get size() {
        return this.pending.size;
    }

    has(id: string) {
        return this.pending.has(id);
    }

    add(annotation: PendingAnnotation) {
        this.pending.set(annotation.id, annotation);

        const pageView = this.child.getPage(annotation.page);
        if (pageView) this.drawPage(annotation.page, pageView);
    }

    remove(id: string) {
        const annotation = this.pending.get(id);
        if (!annotation) return;

        this.pending.delete(id);
        const pageView = this.child.getPage(annotation.page);
        if (pageView) this.drawPage(annotation.page, pageView);
    }

    /**
     * Drop every pending mark. Call when the document has genuinely reloaded: PDF.js
     * now renders these annotations itself, and leaving the stand-ins would double them.
     */
    clear() {
        this.pending.clear();
        this.child.containerEl
            .querySelectorAll(`.${LAYER_CLASS}`)
            .forEach((el) => el.remove());
    }

    private drawPage(pageNumber: number, pageView: PDFPageView) {
        pageView.div.querySelectorAll(`.${LAYER_CLASS} .${MARK_CLASS}`).forEach((el) => el.remove());

        for (const annotation of this.pending.values()) {
            if (annotation.page !== pageNumber) continue;

            for (const rect of annotation.rects) {
                this.drawRect(annotation, rect, pageView);
            }
        }
    }

    private drawRect(annotation: PendingAnnotation, rect: Rect, pageView: PDFPageView) {
        const { r, g, b } = annotation.rgb;
        const markEl = this.lib.highlight.viewer.placeRectInPage(rect, pageView, {
            layerClass: LAYER_CLASS, elClass: MARK_CLASS,
        });

        markEl.dataset.annotationId = annotation.id;
        markEl.dataset.subtype = annotation.subtype;
        markEl.style.setProperty('--pdf-plus-pending-annotation-color', `${r}, ${g}, ${b}`);
        markEl.style.setProperty('--pdf-plus-pending-annotation-opacity', `${annotation.opacity}`);
        markEl.setAttribute('aria-label', 'Added by PDF++ · click to open');

        markEl.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            this.materialize(annotation.id);
        });
    }

    /**
     * Reload the document for real so PDF.js picks up the annotation, then open its
     * popup. This is the deferred cost of not reloading on every write.
     */
    async materialize(id: string) {
        const file = this.child.file;
        const annotation = this.pending.get(id);
        if (!file || !annotation) return;

        // Let the reload through: without this the write is still inside the
        // self-write window and `onModify` would skip it.
        this.plugin.selfWrites.forget(file.path);
        this.clear();

        const subpath = this.currentSubpath();
        await this.child.loadFile(file, subpath);

        this.openPopupWhenReady(annotation);
    }

    /** The current scroll position, so a reload lands where the reader already is. */
    private currentSubpath(): string | undefined {
        const pdfViewer = this.child.pdfViewer?.pdfViewer;
        if (!pdfViewer) return undefined;

        return this.lib.viewStateToSubpath({
            file: this.child.file?.path ?? '',
            page: pdfViewer._location?.pageNumber ?? pdfViewer.currentPageNumber,
            left: pdfViewer._location?.left,
            top: pdfViewer._location?.top,
            zoom: pdfViewer.currentScale,
        }) ?? undefined;
    }

    private openPopupWhenReady(annotation: PendingAnnotation) {
        // The annotation layer for the page may not be built yet after a reload.
        // Watch until it is, then give up rather than listening forever.
        //
        // The watcher stands alone rather than being a child of this layer: reloading
        // the file replaces this instance, and the popup still has to open afterwards.
        const watcher = new Component();
        watcher.load();

        this.lib.onAnnotationLayerReady(this.child.pdfViewer, watcher, (pageNumber, pageView) => {
            if (pageNumber !== annotation.page) return;

            const annotationElement = pageView.annotationLayer?.annotationLayer.getAnnotation(annotation.id);
            if (!annotationElement) return;

            this.child.renderAnnotationPopup(annotationElement);
            watcher.unload();
        });

        activeWindow.setTimeout(() => watcher.unload(), 3000);
    }
}
