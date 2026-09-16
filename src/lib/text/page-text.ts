import type { TextContentItem } from 'typings';


/**
 * A range of text in a page's text layer, in the same form as the `selection=`
 * parameter of PDF++ links: `selection=<beginIndex>,<beginOffset>,<endIndex>,<endOffset>`.
 *
 * `beginIndex`/`endIndex` are indices into the array of text content items, and
 * the offsets are character offsets into the corresponding item's `str`.
 * `endOffset` is exclusive, matching `Range.endOffset` and `PDFPlusLib.getSelectedText`.
 */
export interface PDFTextRange {
    beginIndex: number;
    beginOffset: number;
    endIndex: number;
    endOffset: number;
}

export function textRangeToSelectionParam(range: PDFTextRange): string {
    return `${range.beginIndex},${range.beginOffset},${range.endIndex},${range.endOffset}`;
}

/** A position inside the text layer: which text content item, and where in it. */
interface TextPos {
    index: number;
    offset: number;
}

const DASHES = /[‐‑‒–—−]/;
const QUOTES: Record<string, string> = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"',
    ' ': ' ', ' ': ' ', ' ': ' ',
};

/** Normalize a single character for matching. May expand to several characters (e.g. ligatures). */
function normalizeChar(char: string): string {
    const mapped = QUOTES[char] ?? (DASHES.test(char) ? '-' : char);
    return mapped.normalize('NFKC').toLowerCase();
}

/** Normalize a whole string the same way `PageText` normalizes the page. */
export function normalizeForMatching(text: string): string {
    let out = '';
    for (const char of text) {
        const normalized = normalizeChar(char);
        for (const c of normalized) {
            if (/\s/.test(c)) {
                if (out.length && !out.endsWith(' ')) out += ' ';
            } else {
                out += c;
            }
        }
    }
    return out.trim();
}

/**
 * A searchable, normalized view of one page's text, with a map back to text layer positions.
 *
 * Built from the text content items that PDF.js produces (`page.getTextContent()`), which is the
 * same array the text layer and `HighlightGeometryLib` work with. That is what lets a phrase found
 * here be turned into rectangles on the page.
 *
 * The normalization matters: models quote text as a reader sees it, but a PDF stores it as the
 * typesetter left it. A phrase like "sentiment analysis" can be stored as "senti-" + newline +
 * "ment analysis", and ligatures, curly quotes and en dashes all differ from what a model returns.
 */
export class PageText {
    /** Normalized page text: lowercase, single spaces, no line-break hyphens, NFKC. */
    readonly text: string;
    /** For each character of `text`, the position in the text layer it came from. */
    private readonly positions: TextPos[];

    private constructor(text: string, positions: TextPos[]) {
        this.text = text;
        this.positions = positions;
    }

    static fromItems(items: TextContentItem[]): PageText {
        let text = '';
        const positions: TextPos[] = [];

        const push = (char: string, index: number, offset: number) => {
            text += char;
            positions.push({ index, offset });
        };

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const str = item.str ?? '';
            let droppedLineBreakHyphen = false;

            for (let offset = 0; offset < str.length; offset++) {
                const char = str.charAt(offset);

                // A hyphen at the end of a line is usually a word broken across lines,
                // so drop it and join the halves. "senti-" + "ment" becomes "sentiment".
                const isLastVisible = str.slice(offset + 1).trim() === '';
                if (item.hasEOL && isLastVisible && (char === '-' || DASHES.test(char))) {
                    droppedLineBreakHyphen = true;
                    break;
                }

                for (const c of normalizeChar(char)) {
                    if (/\s/.test(c)) {
                        if (text.length && !text.endsWith(' ')) push(' ', index, offset);
                    } else {
                        push(c, index, offset);
                    }
                }
            }

            // Items are only separated by a space when the line ends. Items on the same line are
            // often two halves of one word (a font change mid-word), so joining them is correct.
            // A dropped line-break hyphen means the word continues on the next line: no space.
            if (item.hasEOL && !droppedLineBreakHyphen && text.length && !text.endsWith(' ')) {
                push(' ', index, Math.max(0, str.length - 1));
            }
        }

        // Trailing space would never be part of a match.
        while (text.endsWith(' ')) {
            text = text.slice(0, -1);
            positions.pop();
        }

        return new PageText(text, positions);
    }

    get length(): number {
        return this.text.length;
    }

    /** The number of space-separated words, used for density targets. */
    countWords(): number {
        return this.text.length ? this.text.split(' ').filter((w) => w.length).length : 0;
    }

    /** Map a character offset in `text` back to a text layer position. */
    offsetToPos(offset: number): TextPos | null {
        return this.positions[offset] ?? null;
    }

    /** Turn a `[from, to)` character range of `text` into a text layer range. */
    toTextRange(from: number, to: number): PDFTextRange | null {
        const begin = this.offsetToPos(from);
        const last = this.offsetToPos(to - 1);
        if (!begin || !last) return null;
        return {
            beginIndex: begin.index,
            beginOffset: begin.offset,
            endIndex: last.index,
            endOffset: last.offset + 1,
        };
    }

    /**
     * Find a quoted phrase on the page.
     *
     * Returns `null` when the phrase is not on the page verbatim. That is the point: a model that
     * paraphrases must not produce a highlight, so callers drop what does not match rather than
     * guessing at the nearest text.
     *
     * @param searchFrom Character offset to start from. Passing the end of the previous match
     * resolves repeated phrases in the order they were returned.
     */
    findQuote(quote: string, searchFrom = 0): { range: PDFTextRange, from: number, to: number } | null {
        const normalized = normalizeForMatching(quote);
        if (!normalized) return null;

        const candidates = [normalized];
        // Models often include or omit trailing punctuation that belongs to the sentence.
        const trimmed = normalized.replace(/^[\s"'([{]+/, '').replace(/[\s"'.,;:!?)\]}]+$/, '');
        if (trimmed && trimmed !== normalized) candidates.push(trimmed);

        for (const candidate of candidates) {
            let at = this.text.indexOf(candidate, searchFrom);
            if (at < 0 && searchFrom > 0) at = this.text.indexOf(candidate);
            if (at < 0) continue;

            const to = at + candidate.length;
            const range = this.toTextRange(at, to);
            if (range) return { range, from: at, to };
        }

        return null;
    }
}
