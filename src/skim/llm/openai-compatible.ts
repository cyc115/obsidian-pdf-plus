import { requestUrl } from 'obsidian';

import { buildSystemPrompt, buildUserPrompt, parseSkimReply } from '../prompt';
import { SkimError, SkimPageResult, SkimProvider, SkimRequest } from '../types';


/**
 * Talks to any endpoint that speaks the OpenAI chat completions shape: OpenRouter,
 * Ollama, LM Studio, vLLM, llama.cpp.
 *
 * Uses Obsidian's `requestUrl` rather than `fetch` so the request is not subject to
 * browser CORS rules and works on mobile.
 */
export class OpenAICompatibleProvider implements SkimProvider {
    constructor(
        readonly id: string,
        private readonly endpoint: string,
        readonly modelId: string,
        private readonly apiKey: string,
        private readonly isOpenRouter: boolean,
    ) { }

    async pickSpans(request: SkimRequest): Promise<SkimPageResult> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        if (this.isOpenRouter) {
            headers['HTTP-Referer'] = 'https://github.com/RyotaUshio/obsidian-pdf-plus';
            headers['X-Title'] = 'Obsidian PDF++';
        }

        const body: Record<string, unknown> = {
            model: this.modelId,
            temperature: 0,
            max_tokens: 2000,
            messages: [
                { role: 'system', content: buildSystemPrompt(request.densityPercent) },
                { role: 'user', content: buildUserPrompt(request) },
            ],
            // Several models reason by default and spend the whole token budget before
            // answering, which truncates the reply. Picking phrases needs no deliberation.
            reasoning: { enabled: false },
        };

        const response = await requestUrl({
            url: this.endpoint,
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            throw: false,
        });

        if (response.status >= 400) {
            throw new SkimError(
                `${this.id} returned ${response.status}.`,
                errorHint(response.status, response.text)
            );
        }

        const choice = response.json?.choices?.[0];
        const message = choice?.message;
        // Some models leave `content` null and put the answer in `reasoning`.
        const text: string = message?.content || message?.reasoning || '';
        if (!text) throw new SkimError('The model returned an empty reply.');

        const parsed = parseSkimReply(text);
        if (!parsed) {
            const truncated = choice?.finish_reason === 'length';
            throw new SkimError(
                truncated ? 'The model ran out of tokens before finishing.' : 'The model did not return usable JSON.',
                truncated ? 'Try a model that does not think before answering.' : undefined
            );
        }
        return parsed;
    }
}

export function errorHint(status: number, text: string): string | undefined {
    if (status === 401 || status === 403) return 'Check the API key in PDF++ settings.';
    if (status === 402) return 'The account is out of credit.';
    if (status === 404) return 'Check the model name and the endpoint.';
    if (status === 429) return 'Rate limited. Wait a moment and try again.';
    if (status >= 500) return 'The provider is having trouble. Try again shortly.';
    return text ? text.slice(0, 200) : undefined;
}
