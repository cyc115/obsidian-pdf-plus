import { PDFPlusSettings } from 'settings';
import { SkimProvider, SkimError } from '../types';
import { OpenAICompatibleProvider } from './openai-compatible';
import { AnthropicProvider } from './anthropic';


export const SKIM_PROVIDERS = {
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    'openai-compatible': 'OpenAI-compatible (Ollama, LM Studio, ...)',
} as const;

export type SkimProviderId = keyof typeof SKIM_PROVIDERS;

/** Endpoints that don't need a key, so the settings tab can stop nagging about one. */
export function providerNeedsApiKey(provider: SkimProviderId, endpoint: string): boolean {
    if (provider !== 'openai-compatible') return true;
    return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(endpoint.trim());
}

export function createSkimProvider(settings: PDFPlusSettings): SkimProvider {
    const apiKey = settings.skimApiKey.trim();
    const model = settings.skimModel.trim();

    if (!model) {
        throw new SkimError('No model is set.', 'Set one in PDF++ settings, under Skim highlights.');
    }

    switch (settings.skimProvider) {
        case 'anthropic':
            if (!apiKey) throw new SkimError('No API key is set.', 'Add one in PDF++ settings, under Skim highlights.');
            return new AnthropicProvider(model, apiKey);
        case 'openai-compatible': {
            const endpoint = settings.skimEndpoint.trim();
            if (!endpoint) {
                throw new SkimError('No endpoint is set.', 'Add one in PDF++ settings, under Skim highlights.');
            }
            if (!apiKey && providerNeedsApiKey('openai-compatible', endpoint)) {
                throw new SkimError('No API key is set.', 'Add one in PDF++ settings, under Skim highlights.');
            }
            return new OpenAICompatibleProvider('openai-compatible', endpoint, model, apiKey, false);
        }
        case 'openrouter':
        default:
            if (!apiKey) throw new SkimError('No API key is set.', 'Add one in PDF++ settings, under Skim highlights.');
            return new OpenAICompatibleProvider(
                'openrouter', 'https://openrouter.ai/api/v1/chat/completions', model, apiKey, true
            );
    }
}
