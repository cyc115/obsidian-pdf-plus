import { SkimRequest } from './types';


/**
 * Bumped whenever the rubric changes. It is part of the cache key, so old results
 * are never shown under a new rubric.
 */
export const PROMPT_VERSION = 'v1';

/**
 * The rubric is read off a page the user marked by hand, so it encodes their taste:
 * short phrases rather than sentences, every item of a list, the author's signposts,
 * and nothing for examples, brand names or a summary paragraph.
 */
export function buildSystemPrompt(densityPercent: number): string {
    const lo = Math.max(5, Math.round(densityPercent * 0.7));
    const hi = Math.min(60, Math.round(densityPercent * 1.4));
    return [
        'You mark the phrases a reader should see when skimming one page of a technical document.',
        '',
        'Rules:',
        '- Mark PHRASES, not whole sentences. Most marks are 2 to 7 words. Mark a full clause only when the author states what the reader will learn or do.',
        '- Mark each item in an enumeration separately, and mark the core capability or claim of a paragraph.',
        '- Mark author signposts such as "we will focus on ..." or "you will learn ...".',
        '- Do NOT mark examples, product or brand names, figure or table references, citations, or parenthetical asides.',
        '- Do NOT mark the running head, chapter title, page number, or section number.',
        '- A paragraph may get no marks. A page of pure code or references may get none at all.',
        '- Quote text EXACTLY as it appears on the page, including punctuation inside the phrase. A phrase that is not on the page verbatim is discarded.',
        `- Aim for ${lo} to ${hi} percent of the words on the page. Fewer good marks beat more weak ones.`,
        '',
        'Return ONLY JSON, with no markdown fence:',
        '{"gist": "<one line, max 15 words, what this page says>", "spans": [{"quote": "<exact text>", "tier": 1}]}',
        'tier 1 = must see, tier 2 = useful.',
    ].join('\n');
}

export function buildUserPrompt(request: SkimRequest): string {
    const context = [`Document: ${request.title}`];
    if (request.heading) context.push(`Section: ${request.heading}`);
    if (request.previousGist) context.push(`Previous page said: ${request.previousGist}`);
    if (request.readingGoal) context.push(`The reader cares about: ${request.readingGoal}`);
    return `${context.join('\n')}\n\nPage ${request.pageLabel}:\n${request.pageText}`;
}

/** Pull the JSON object out of a reply, tolerating fences and stray text around it. */
export function parseSkimReply(raw: string): { gist: string, spans: { quote: string, tier: 1 | 2 }[] } | null {
    const text = raw.replace(/^\s*```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text.charAt(i);
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
            depth--;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(text.slice(start, i + 1));
                    if (!parsed || !Array.isArray(parsed.spans)) return null;
                    return {
                        gist: typeof parsed.gist === 'string' ? parsed.gist : '',
                        spans: parsed.spans
                            .filter((span: any) => span && typeof span.quote === 'string')
                            .map((span: any) => ({
                                quote: span.quote as string,
                                tier: span.tier === 2 ? 2 : 1,
                            })),
                    };
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/**
 * Models sometimes mark the section heading ("1.2 Applications of LLMs") even when told not to.
 * A heading is already visible without help, so it is dropped here rather than argued about
 * in the prompt.
 */
export function isSectionHeading(quote: string): boolean {
    const trimmed = quote.trim();
    return /^\d+(\.\d+)*\s+\S/.test(trimmed) && trimmed.split(/\s+/).length <= 8;
}
