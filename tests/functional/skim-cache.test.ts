import { beforeEach, describe, expect, test } from 'vitest';
import { TFile } from 'obsidian';

import { SkimCache } from 'skim/skim-cache';
import { SkimPageResult } from 'skim/types';
import { createFakePlugin } from '../harness/plugin';
import { FakeAdapter } from '../harness/vault';

/**
 * What the skim cache must get right, stated in terms of money.
 *
 * Every miss is an LLM call the user pays for, so the question these tests ask is
 * not "is the entry still there" but "does the file having changed on disk force us
 * to buy this page again". PDF++ writes annotations into the PDF constantly, and
 * those writes change the file's bytes without moving a character of page text.
 */

const PAGE_TEXT = 'Distributed systems fail in ways that are hard to reproduce locally.';
const OTHER_TEXT = 'Consensus protocols trade latency for durability under partition.';

function result(gist: string): SkimPageResult {
    return { gist, spans: [{ quote: 'fail in ways', tier: 1 }] };
}

/** An annotation write: the bytes and mtime move, the text does not. */
function touchFile(file: TFile) {
    file.stat = { ...file.stat, mtime: file.stat.mtime + 5000, size: file.stat.size + 412 };
}

describe('SkimCache', () => {
    let cache: SkimCache;
    let file: TFile;
    let adapter: FakeAdapter;
    let plugin: any;

    beforeEach(() => {
        const harness = createFakePlugin();
        plugin = harness.plugin;
        adapter = harness.vault.adapter;
        file = harness.vault.createBinaryFile('papers/raft.pdf', new Uint8Array([1, 2, 3]));
        cache = new SkimCache(plugin);
    });

    test('an annotation write does not cost a re-analysis', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('how systems fail'));

        // PDF++ writes a highlight into the PDF: new mtime, new size, same text.
        touchFile(file);

        await cache.load(file);
        expect(cache.get(file, 1, PAGE_TEXT)).toEqual(result('how systems fail'));
    });

    test('text that actually changed misses', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('how systems fail'));
        await cache.load(file);

        expect(cache.get(file, 1, OTHER_TEXT)).toBeNull();
    });

    test('only the pages whose text moved are invalidated', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('page one'));
        await cache.set(file, 2, OTHER_TEXT, result('page two'));

        // Page 1 was re-typeset; page 2 is untouched.
        await cache.load(file);
        expect(cache.get(file, 1, 'something else entirely on page one')).toBeNull();
        expect(cache.get(file, 2, OTHER_TEXT)).toEqual(result('page two'));
    });

    test('a different model or density misses', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('how systems fail'));
        await cache.load(file);
        expect(cache.get(file, 1, PAGE_TEXT)).not.toBeNull();

        plugin.settings.skimDensityPercent = 40;
        expect(cache.get(file, 1, PAGE_TEXT)).toBeNull();

        plugin.settings.skimDensityPercent = 18;
        plugin.settings.skimModel = 'a-different-model';
        expect(cache.get(file, 1, PAGE_TEXT)).toBeNull();
    });

    test('survives a reload of the cache from disk', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('how systems fail'));
        touchFile(file);

        // A fresh process: nothing in memory, everything from the JSON on disk.
        const reopened = new SkimCache(plugin);
        await reopened.load(file);
        expect(reopened.get(file, 1, PAGE_TEXT)).toEqual(result('how systems fail'));
    });

    test('a cache file from an older format is ignored rather than trusted', async () => {
        // The pre-text-hash shape: keyed by settings alone, guarded by mtime.
        adapter.seed(pathFor(plugin, file), JSON.stringify({
            path: file.path,
            size: file.stat.size,
            mtime: file.stat.mtime,
            pages: { '1': { 'test-model|1|18|': result('stale') } },
        }));

        await cache.load(file);
        expect(cache.get(file, 1, PAGE_TEXT)).toBeNull();
    });

    test('malformed JSON on disk does not throw', async () => {
        adapter.seed(pathFor(plugin, file), '{ not json');
        await expect(cache.load(file)).resolves.toBeTruthy();
        expect(cache.get(file, 1, PAGE_TEXT)).toBeNull();
    });

    test('a page keeps only its most recent entries', async () => {
        // Each edit to the page produces another text version of the same page.
        for (let i = 0; i < 5; i++) {
            await cache.set(file, 1, `${PAGE_TEXT} revision ${i}`, result(`v${i}`));
        }
        await cache.load(file);

        const stored = JSON.parse(adapter.peek(pathFor(plugin, file))!);
        expect(Object.keys(stored.pages['1'])).toHaveLength(SkimCache.MAX_ENTRIES_PER_PAGE);

        // The newest survives, the oldest is gone.
        expect(cache.get(file, 1, `${PAGE_TEXT} revision 4`)).toEqual(result('v4'));
        expect(cache.get(file, 1, `${PAGE_TEXT} revision 0`)).toBeNull();
    });

    test('clear removes the document from disk', async () => {
        await cache.set(file, 1, PAGE_TEXT, result('how systems fail'));
        await cache.clear(file);

        await cache.load(file);
        expect(cache.get(file, 1, PAGE_TEXT)).toBeNull();
    });
});

/** The cache names its files by hashing the path, so ask it rather than guessing. */
function pathFor(plugin: any, file: TFile): string {
    return (new SkimCache(plugin) as any).path(file);
}
