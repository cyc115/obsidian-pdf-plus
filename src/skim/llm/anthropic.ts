import { requestUrl } from 'obsidian';

import { buildSystemPrompt, buildUserPrompt, parseSkimReply } from '../prompt';
import { SkimError, SkimPageResult, SkimProvider, SkimRequest } from '../types';
import { errorHint } from './openai-compatible';


/** Talks to the Anthropic messages API directly, through Obsidian's `requestUrl`. */
export class AnthropicProvider implements SkimProvider {
    readonly id = 'anthropic';

    constructor(readonly modelId: string, private readonly apiKey: string) { }

    async pickSpans(request: SkimRequest): Promise<SkimPageResult> {
        const response = await requestUrl({
            url: 'https://api.anthropic.com/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                // Obsidian's requestUrl is not a browser fetch, but Anthropic still wants
                // this header from any client that runs on a user's machine.
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: this.modelId,
                max_tokens: 2000,
                system: buildSystemPrompt(request.densityPercent),
                messages: [{ role: 'user', content: buildUserPrompt(request) }],
            }),
            throw: false,
        });

        if (response.status >= 400) {
            throw new SkimError(`Anthropic returned ${response.status}.`, errorHint(response.status, response.text));
        }

        if (response.json?.stop_reason === 'refusal') {
            throw new SkimError('The model declined to answer for this page.');
        }

        const text: string = (response.json?.content ?? [])
            .filter((block: any) => block?.type === 'text')
            .map((block: any) => block.text)
            .join('');
        if (!text) throw new SkimError('The model returned an empty reply.');

        const parsed = parseSkimReply(text);
        if (!parsed) {
            const truncated = response.json?.stop_reason === 'max_tokens';
            throw new SkimError(
                truncated ? 'The model ran out of tokens before finishing.' : 'The model did not return usable JSON.'
            );
        }
        return parsed;
    }
}
