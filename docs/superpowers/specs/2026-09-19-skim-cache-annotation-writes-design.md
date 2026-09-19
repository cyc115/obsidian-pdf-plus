# Skim results survive PDF++'s own annotation writes

Date: 2026-09-19
Status: approved

## Problem

Adding a highlight makes the skim overlay vanish and reappear a few seconds later,
and each of those reappearances is paid for with real LLM calls.

Two defects, one shared false assumption: *the PDF file changed, therefore the page
text changed*. That holds for an edit made in another app. It does not hold for a
PDF++ annotation write, which changes the file's bytes without touching a single
character of any page's text.

### Defect 1 - our own writes reset skim

`SkimController.onload` resets on every vault `modify` for the open file:

```js
this.registerEvent(this.app.vault.on('modify', (file) => {
    if (file === this.file) this.reset();
}));
```

`reset()` clears every mark (the overlay disappears) and calls
`analyzeAround(currentPage)`, which re-queues the current page plus
`skimPagesAhead` (default 2).

This fires for PDF++'s own annotation writes - the very writes the viewer
deliberately does not reload for, since commit 2d5103a.

### Defect 2 - the cache cannot absorb the re-analysis

`SkimCache` keys validity on the PDF's `mtime` and `size`
(`skim-cache.ts:69,79,88`). An annotation write changes both, so every lookup after
a highlight misses:

> **3 real LLM calls per highlight** (current page + 2 ahead), every time.

The cache then rewrites itself under the new mtime, and the next highlight
invalidates it again. The damage outlives the session: highlighting a document
poisons its cache, so reopening it later re-analyzes every page from scratch.

## Design

### 1. Guard the modify listener

Skip the reset when the write was ours, mirroring the guard already on
`PDFView.onLoadFile`:

```js
this.registerEvent(this.app.vault.on('modify', (file) => {
    if (file !== this.file) return;
    if (this.plugin.selfWrites.isSelfWrite(file.path)) return;
    this.reset();
}));
```

Deliberately *not* gated on `deferReloadOnSelfEdit`. That setting governs whether
the viewer reloads; this governs whether the text changed. They are different
questions, and when reloads are enabled the controller is rebuilt anyway.

### 2. Key cached results on the page text

`SkimCache` stops storing `mtime`/`size` as validity fields. A cached result is
addressed by:

```
`${pageText.length}-${hash32(pageText)}` + '|' + settingsKey()
```

Length is folded in so a 32-bit collision must also match length.

Consequences:

- An annotation write no longer invalidates anything, because no page's text moved.
- An external edit invalidates only the pages whose text actually changed, rather
  than the whole document.

`analyze()` currently consults the cache *before* extracting the page text. Text-keyed
lookup needs the text first, so extraction moves above the lookup. It is a local
PDF.js call with no network, and the non-cached path already paid it.

### 3. Cache file format and migration

Old entries cannot be migrated: they never stored a text hash, and it cannot be
reconstructed from what is on disk. The cache file gains a `version` field, and any
file without the current version is ignored. Cost is one re-analysis per document,
once.

### 4. Bounded growth

`mtime` is what used to bound the file's size - a changed mtime wiped every entry.
Without it, entries accumulate one per text-version per page. Writes keep at most the
3 most recent entries per page, evicting oldest first. This is a guard made necessary
by removing `mtime`, not a feature.

## Testing

**vitest** (`SkimCache`):

- same text hits even though mtime and size changed
- changed text misses
- changed settings key misses
- a file written in the old format is ignored, and does not throw
- a page keeps at most 3 entries, evicting the oldest

**e2e** (real Obsidian): install a counting fake provider, enable skim, wait for
marks, then add a highlight. Assert the mark count never drops to zero *and* the
provider's call count does not move. One user-visible property covering both defects;
this is the test that would have caught the bug.

## Non-goals

- Growth of `pages[n][settingsKey]` across model/density changes. Predates this bug.
- `analyzeAround`'s look-ahead policy. Predates this bug.
