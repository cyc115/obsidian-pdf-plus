import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

export interface FixtureOptions {
    pages?: number;
    width?: number;
    height?: number;
}

/**
 * Build a small, deterministic PDF to annotate.
 *
 * Generated rather than committed as a binary so the page geometry the tests
 * assert against is visible right here in the source.
 */
export async function createTestPdfBytes(options: FixtureOptions = {}): Promise<Uint8Array> {
    const { pages = 2, width = 612, height = 792 } = options;

    const doc = await PDFDocument.create();
    doc.setTitle('PDF++ test fixture');
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let i = 0; i < pages; i++) {
        const page = doc.addPage([width, height]);
        page.drawText(`Page ${i + 1}: the quick brown fox jumps over the lazy dog.`, {
            x: 72, y: height - 100, size: 14, font,
        });
        page.drawText('A second line of text for multi-rect selections.', {
            x: 72, y: height - 130, size: 14, font,
        });
    }

    return await doc.save();
}
