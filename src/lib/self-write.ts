/**
 * Tracks file writes that PDF++ made itself.
 *
 * Obsidian reloads an open PDF view whenever the file it shows changes on disk
 * (`PDFView.onModify` -> `onLoadFile` -> `PDFViewerComponent.loadFile`), which
 * re-fetches and re-parses the whole document. That is correct for edits made by
 * another app, but when PDF++ is the one writing - adding a highlight, say - the
 * viewer already knows what changed, and the reload is just a flash.
 *
 * A write is remembered for a short window rather than consumed once, because a
 * single modification reaches every view showing that file, and each one asks
 * independently whether it should reload.
 */
export class SelfWriteTracker {
    /** How long after a write a `modify` event is still attributed to us. */
    static readonly WINDOW_MS = 1500;

    private pending = new Map<string, number>();

    /** Call immediately before writing to the vault. */
    markWrite(path: string) {
        this.pending.set(path, Date.now() + SelfWriteTracker.WINDOW_MS);
    }

    /** Whether a `modify` event arriving now for `path` is one PDF++ caused. */
    isSelfWrite(path: string): boolean {
        const expiry = this.pending.get(path);
        if (expiry === undefined) return false;

        if (Date.now() > expiry) {
            this.pending.delete(path);
            return false;
        }
        return true;
    }

    /**
     * Forget a pending write, so the next `modify` event for this file reloads the
     * view as usual. Used when we deliberately want the reload - see
     * `PendingAnnotationLayer.materialize`.
     */
    forget(path: string) {
        this.pending.delete(path);
    }

    clear() {
        this.pending.clear();
    }
}
