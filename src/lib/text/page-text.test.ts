import { describe, expect, test } from 'vitest';

import { PageText, normalizeForMatching } from './page-text';
import type { TextContentItem } from 'typings';

/** Build text content items the way PDF.js reports them: one item per run, `hasEOL` ends a line. */
function items(...lines: (string | string[])[]): TextContentItem[] {
    const out: TextContentItem[] = [];
    for (const line of lines) {
        const runs = Array.isArray(line) ? line : [line];
        runs.forEach((str, i) => {
            out.push({
                str,
                dir: 'ltr',
                width: str.length * 5,
                height: 10,
                transform: [1, 0, 0, 1, 0, 0],
                fontName: 'g_d0_f1',
                hasEOL: i === runs.length - 1,
            });
        });
    }
    return out;
}

describe('normalizeForMatching', () => {
    test('collapses whitespace and lowercases', () => {
        expect(normalizeForMatching('  Machine   Translation\n')).toBe('machine translation');
    });

    test('unifies curly quotes and dashes', () => {
        expect(normalizeForMatching('OpenAI’s “Gemini” — formerly Bard')).toBe('openai\'s "gemini" - formerly bard');
    });

    test('expands ligatures', () => {
        expect(normalizeForMatching('ﬁne-tuning')).toBe('fine-tuning');
    });
});

describe('PageText.fromItems', () => {
    test('joins a word broken by a line-break hyphen', () => {
        const page = PageText.fromItems(items('employed for senti-', 'ment analysis'));
        expect(page.text).toBe('employed for sentiment analysis');
    });

    test('keeps a real hyphen inside a line', () => {
        const page = PageText.fromItems(items('rule-based systems'));
        expect(page.text).toBe('rule-based systems');
    });

    test('joins runs on the same line without adding a space', () => {
        // A font change mid-word splits one word into two items.
        const page = PageText.fromItems(items([' trans', 'former']));
        expect(page.text).toBe('transformer');
    });

    test('separates lines with a single space', () => {
        const page = PageText.fromItems(items('knowledge retrieval', 'from vast volumes'));
        expect(page.text).toBe('knowledge retrieval from vast volumes');
    });

    test('counts words', () => {
        expect(PageText.fromItems(items('one two three')).countWords()).toBe(3);
    });
});

describe('PageText.findQuote', () => {
    const page = PageText.fromItems(
        items(
            'Today, LLMs are employed for machine translation, senti-',
            'ment analysis, text summarization, and many other tasks.',
            'LLMs can also power sophisticated chatbots.',
        )
    );

    test('finds a phrase and maps it back to the text layer', () => {
        const hit = page.findQuote('machine translation');
        expect(hit).not.toBeNull();
        expect(hit!.range.beginIndex).toBe(0);
        // The quote must map back to exactly the characters it matched.
        expect(page.text.slice(hit!.from, hit!.to)).toBe('machine translation');
    });

    test('finds a phrase broken across a line by a hyphen', () => {
        const hit = page.findQuote('sentiment analysis, text summarization');
        expect(hit).not.toBeNull();
        // It starts on the first line and ends on the second.
        expect(hit!.range.beginIndex).toBe(0);
        expect(hit!.range.endIndex).toBe(1);
    });

    test('tolerates trailing punctuation the model added', () => {
        expect(page.findQuote('sophisticated chatbots.')).not.toBeNull();
        expect(page.findQuote('"sophisticated chatbots"')).not.toBeNull();
    });

    test('ignores case and curly quotes', () => {
        expect(page.findQuote('MACHINE TRANSLATION')).not.toBeNull();
    });

    test('returns null for a paraphrase rather than guessing', () => {
        expect(page.findQuote('trained to predict the next word')).toBeNull();
        expect(page.findQuote('LLMs are used for translating machines')).toBeNull();
    });

    test('resolves a repeated phrase in the order asked for', () => {
        const repeated = PageText.fromItems(items('alpha beta', 'gamma beta delta'));
        const first = repeated.findQuote('beta')!;
        const second = repeated.findQuote('beta', first.to)!;
        expect(second.from).toBeGreaterThan(first.from);
    });

    test('an end offset is exclusive, as PDF++ selection links expect', () => {
        const single = PageText.fromItems(items('alpha beta'));
        const hit = single.findQuote('alpha')!;
        expect(hit.range).toEqual({ beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 5 });
    });
});
