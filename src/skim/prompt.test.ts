import { describe, expect, test } from 'vitest';

import { isSectionHeading, parseSkimReply } from './prompt';

describe('isSectionHeading', () => {
    test('rejects a numbered heading', () => {
        expect(isSectionHeading('1.2 Applications of LLMs')).toBe(true);
        expect(isSectionHeading('2 Working with text data')).toBe(true);
    });

    test('keeps ordinary text that starts with a number', () => {
        expect(isSectionHeading('2019 saw the release of a model that changed how researchers think about scale')).toBe(false);
        expect(isSectionHeading('machine translation, generation of novel texts')).toBe(false);
    });
});

describe('parseSkimReply', () => {
    test('reads a plain reply', () => {
        const parsed = parseSkimReply('{"gist":"a page","spans":[{"quote":"knowledge retrieval","tier":1}]}');
        expect(parsed).toEqual({ gist: 'a page', spans: [{ quote: 'knowledge retrieval', tier: 1 }] });
    });

    test('reads a reply wrapped in a markdown fence with chatter around it', () => {
        const parsed = parseSkimReply('Sure!\n```json\n{"gist":"g","spans":[{"quote":"q","tier":2}]}\n```\n');
        expect(parsed!.spans[0]).toEqual({ quote: 'q', tier: 2 });
    });

    test('handles braces inside a quoted phrase', () => {
        const parsed = parseSkimReply('{"gist":"","spans":[{"quote":"the set {a, b}","tier":1}]}');
        expect(parsed!.spans[0].quote).toBe('the set {a, b}');
    });

    test('defaults a missing or odd tier to 1', () => {
        const parsed = parseSkimReply('{"gist":"","spans":[{"quote":"q"},{"quote":"r","tier":9}]}');
        expect(parsed!.spans.map((s) => s.tier)).toEqual([1, 1]);
    });

    test('drops spans without a quote, and rejects unusable replies', () => {
        expect(parseSkimReply('{"gist":"","spans":[{"tier":1}]}')!.spans).toHaveLength(0);
        expect(parseSkimReply('no json here')).toBeNull();
        expect(parseSkimReply('{"gist":"truncated","spans":[{"quote":"a')).toBeNull();
    });
});
