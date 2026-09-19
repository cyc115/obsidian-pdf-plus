import { TFile } from 'obsidian';

import PDFPlus from 'main';
import { SkimPageResult } from './types';
import { PROMPT_VERSION } from './prompt';


interface CacheFileContent {
    /** Format version. A file written by an older PDF++ is ignored rather than guessed at. */
    version: number;
    /** Path of the PDF, for readability when inspecting the cache by hand. */
    path: string;
    /** `page number -> entry key -> result`, where the entry key identifies the page's text. */
    pages: Record<string, Record<string, SkimPageResult>>;
}

/** A small, stable string hash. Not cryptographic - it only has to spread text apart. */
function hash32(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
        hash |= 0;
    }
    return hash >>> 0;
}

/**
 * Stores what the model returned, per document and page, in the plugin's folder.
 *
 * Entries are addressed by the page's *text*, not by the file's mtime. PDF++ writes
 * annotations into the PDF all the time, and those writes change the file's bytes
 * without moving a single character of any page - so keying on mtime meant every
 * highlight threw the whole document away and bought it back from the model. Keying
 * on the text says what actually matters: this is the page the model was shown.
 * It also narrows invalidation from "the file changed" to "this page changed".
 *
 * Only quotes are stored, never text layer positions: those come from the PDF.js build
 * Obsidian ships, and an update to it can shift them. Re-anchoring on load costs nothing
 * and keeps the marks correct across upgrades.
 */
export class SkimCache {
    /** Bumped whenever the stored shape changes. Older files are discarded on read. */
    static readonly VERSION = 2;

    /**
     * How many text versions of one page to keep.
     *
     * `mtime` used to bound this file: any change wiped every entry. Text keys do not,
     * so an edited page would otherwise leave its old entry behind forever.
     */
    static readonly MAX_ENTRIES_PER_PAGE = 3;

    private loaded = new Map<string, CacheFileContent>();
    private writing = new Map<string, Promise<void>>();

    constructor(private readonly plugin: PDFPlus) { }

    /** Results are only reused when the model, rubric, density and reading goal all match. */
    settingsKey(): string {
        const { skimModel, skimDensityPercent, skimReadingGoal } = this.plugin.settings;
        return [skimModel.trim(), PROMPT_VERSION, skimDensityPercent, skimReadingGoal.trim()].join('|');
    }

    /**
     * Identifies one analysis: this page's text, under these settings.
     *
     * The length is folded in so that a 32-bit collision would also have to match
     * length before it could serve the wrong marks.
     */
    private entryKey(pageText: string): string {
        return `${pageText.length}-${hash32(pageText).toString(36)}|${this.settingsKey()}`;
    }

    private get dir(): string | null {
        const pluginDir = this.plugin.manifest.dir;
        return pluginDir ? `${pluginDir}/skim-cache` : null;
    }

    private fileName(file: TFile): string {
        // A short, stable, filesystem-safe name derived from the path.
        const base = file.basename.replace(/[^\w-]+/g, '-').slice(0, 40);
        return `${base}-${hash32(file.path).toString(36)}.json`;
    }

    private path(file: TFile): string | null {
        const dir = this.dir;
        return dir ? `${dir}/${this.fileName(file)}` : null;
    }

    async load(file: TFile): Promise<CacheFileContent> {
        const existing = this.loaded.get(file.path);
        if (existing) return existing;

        const fresh: CacheFileContent = { version: SkimCache.VERSION, path: file.path, pages: {} };

        const path = this.path(file);
        if (path) {
            try {
                const adapter = this.plugin.app.vault.adapter;
                if (await adapter.exists(path)) {
                    const content = JSON.parse(await adapter.read(path)) as CacheFileContent;
                    // An older format stored no text key, and one cannot be reconstructed
                    // from what is on disk. Re-analyzing once beats serving the wrong page.
                    if (content?.version === SkimCache.VERSION) {
                        fresh.pages = content.pages ?? {};
                    }
                }
            } catch (error) {
                console.error('PDF++: could not read the skim cache', error);
            }
        }

        this.loaded.set(file.path, fresh);
        return fresh;
    }

    get(file: TFile, pageNumber: number, pageText: string): SkimPageResult | null {
        const content = this.loaded.get(file.path);
        if (!content) return null;
        return content.pages[String(pageNumber)]?.[this.entryKey(pageText)] ?? null;
    }

    async set(file: TFile, pageNumber: number, pageText: string, result: SkimPageResult): Promise<void> {
        const content = await this.load(file);
        const key = String(pageNumber);
        const page = content.pages[key] ?? (content.pages[key] = {});

        // Re-insert rather than overwrite in place, so the newest entry is always last
        // and eviction can simply drop from the front.
        delete page[this.entryKey(pageText)];
        page[this.entryKey(pageText)] = result;

        const keys = Object.keys(page);
        for (const stale of keys.slice(0, Math.max(0, keys.length - SkimCache.MAX_ENTRIES_PER_PAGE))) {
            delete page[stale];
        }

        await this.flush(file, content);
    }

    async clear(file: TFile): Promise<void> {
        this.loaded.delete(file.path);
        const path = this.path(file);
        if (!path) return;
        const adapter = this.plugin.app.vault.adapter;
        if (await adapter.exists(path)) await adapter.remove(path);
    }

    /** Writes are queued per file so two pages finishing at once cannot clobber each other. */
    private flush(file: TFile, content: CacheFileContent): Promise<void> {
        const previous = this.writing.get(file.path) ?? Promise.resolve();
        const next = previous.then(async () => {
            const path = this.path(file);
            if (!path) return;
            const adapter = this.plugin.app.vault.adapter;
            try {
                const dir = this.dir!;
                if (!await adapter.exists(dir)) await adapter.mkdir(dir);
                await adapter.write(path, JSON.stringify(content));
            } catch (error) {
                console.error('PDF++: could not write the skim cache', error);
            }
        });
        this.writing.set(file.path, next);
        return next;
    }
}
