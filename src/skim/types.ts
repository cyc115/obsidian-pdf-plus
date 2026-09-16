import { PDFTextRange } from 'lib/text/page-text';


/** A phrase the model picked out, as it came back from the model. */
export interface SkimSpanResult {
    /** The phrase, quoted verbatim from the page. */
    quote: string;
    /** 1 = must see, 2 = useful. Tier 2 is dropped first when trimming to the density target. */
    tier: 1 | 2;
}

/** What the model returns for one page. */
export interface SkimPageResult {
    /** One line saying what the page is about, passed as context to the next page. */
    gist: string;
    spans: SkimSpanResult[];
}

/** A phrase that was found on the page and can be drawn. */
export interface AnchoredSpan extends SkimSpanResult {
    range: PDFTextRange;
    /** Number of characters the phrase covers, used for the density budget. */
    length: number;
}

export interface SkimRequest {
    pageText: string;
    pageLabel: string;
    /** Document title, usually the file's basename. */
    title: string;
    /** Nearest outline heading, when the document has an outline. */
    heading: string;
    /** One line about the previous page, empty for the first page analyzed. */
    previousGist: string;
    /** What the reader is looking for, from settings. Empty when not set. */
    readingGoal: string;
    /** Target share of the page's words to mark, as a percentage. */
    densityPercent: number;
}

export interface SkimProvider {
    readonly id: string;
    /** A stable identifier for the model, used in the cache key. */
    readonly modelId: string;
    pickSpans(request: SkimRequest): Promise<SkimPageResult>;
}

export class SkimError extends Error {
    constructor(message: string, readonly hint?: string) {
        super(message);
        this.name = 'SkimError';
    }
}
