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

/**
 * The endpoint each provider starts with, so switching providers fills the box with a
 * working URL instead of leaving the previous provider's one behind.
 *
 * Anthropic's messages API is not OpenAI-shaped and its URL is fixed, so it has no entry.
 */
export const PROVIDER_DEFAULT_ENDPOINTS: Record<SkimProviderId, string> = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    anthropic: '',
    'openai-compatible': 'http://localhost:11434/v1/chat/completions',
};

/** The endpoint default shipped by the first skim build, kept only for the migration in `loadSettings`. */
export const LEGACY_SKIM_ENDPOINT = 'http://localhost:11434/v1/chat/completions';

/** Whether the endpoint box applies to this provider. */
export function providerUsesEndpoint(provider: SkimProviderId): boolean {
    return provider !== 'anthropic';
}

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
        default: {
            if (!apiKey) throw new SkimError('No API key is set.', 'Add one in PDF++ settings, under Skim highlights.');
            const endpoint = settings.skimEndpoint.trim() || PROVIDER_DEFAULT_ENDPOINTS.openrouter;
            return new OpenAICompatibleProvider('openrouter', endpoint, model, apiKey, true);
        }
    }
}
