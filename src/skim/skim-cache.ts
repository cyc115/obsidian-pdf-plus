import { TFile } from 'obsidian';

import PDFPlus from 'main';
import { SkimPageResult } from './types';
import { PROMPT_VERSION } from './prompt';


interface CacheFileContent {
    /** Path of the PDF, for readability when inspecting the cache by hand. */
    path: string;
    /** Size and modification time of the PDF, so an edited file is re-analyzed. */
    size: number;
    mtime: number;
    /** `page number -> settings key -> result` */
    pages: Record<string, Record<string, SkimPageResult>>;
}

/**
 * Stores what the model returned, per document and page, in the plugin's folder.
 *
 * Only quotes are stored, never text layer positions: those come from the PDF.js build
 * Obsidian ships, and an update to it can shift them. Re-anchoring on load costs nothing
 * and keeps the marks correct across upgrades.
 */
export class SkimCache {
    private loaded = new Map<string, CacheFileContent>();
    private writing = new Map<string, Promise<void>>();

    constructor(private readonly plugin: PDFPlus) { }

    /** Results are only reused when the model, rubric, density and reading goal all match. */
    settingsKey(): string {
        const { skimModel, skimDensityPercent, skimReadingGoal } = this.plugin.settings;
        return [skimModel.trim(), PROMPT_VERSION, skimDensityPercent, skimReadingGoal.trim()].join('|');
    }

    private get dir(): string | null {
        const pluginDir = this.plugin.manifest.dir;
        return pluginDir ? `${pluginDir}/skim-cache` : null;
    }

    private fileName(file: TFile): string {
        // A short, stable, filesystem-safe name derived from the path.
        let hash = 0;
        for (let i = 0; i < file.path.length; i++) {
            hash = (hash << 5) - hash + file.path.charCodeAt(i);
            hash |= 0;
        }
        const base = file.basename.replace(/[^\w-]+/g, '-').slice(0, 40);
        return `${base}-${(hash >>> 0).toString(36)}.json`;
    }

    private path(file: TFile): string | null {
        const dir = this.dir;
        return dir ? `${dir}/${this.fileName(file)}` : null;
    }

    async load(file: TFile): Promise<CacheFileContent> {
        const existing = this.loaded.get(file.path);
        if (existing && existing.mtime === file.stat.mtime && existing.size === file.stat.size) {
            return existing;
        }

        const fresh: CacheFileContent = {
            path: file.path, size: file.stat.size, mtime: file.stat.mtime, pages: {},
        };

        const path = this.path(file);
        if (path) {
            try {
                const adapter = this.plugin.app.vault.adapter;
                if (await adapter.exists(path)) {
                    const content = JSON.parse(await adapter.read(path)) as CacheFileContent;
                    // A changed PDF invalidates everything: the page numbers may have moved.
                    if (content.mtime === file.stat.mtime && content.size === file.stat.size) {
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

    get(file: TFile, pageNumber: number): SkimPageResult | null {
        const content = this.loaded.get(file.path);
        if (!content || content.mtime !== file.stat.mtime) return null;
        return content.pages[String(pageNumber)]?.[this.settingsKey()] ?? null;
    }

    async set(file: TFile, pageNumber: number, result: SkimPageResult): Promise<void> {
        const content = await this.load(file);
        const page = content.pages[String(pageNumber)] ?? (content.pages[String(pageNumber)] = {});
        page[this.settingsKey()] = result;
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
