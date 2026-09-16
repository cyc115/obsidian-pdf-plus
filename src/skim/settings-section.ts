import { PDFPlusSettingTab } from 'settings';
import { SKIM_PROVIDERS, providerNeedsApiKey } from './llm';


/**
 * The "Skim highlights" section of the settings tab.
 *
 * Kept in its own file so the feature does not add to `settings.ts`, which is already the
 * largest file in the repository and the one most likely to conflict with upstream.
 */
export function addSkimSettings(tab: PDFPlusSettingTab): void {
    tab.addHeading('Skim highlights', 'skim', 'lucide-highlighter')
        .setDesc(
            'A model reads the page you are on and marks the phrases worth seeing, so you can skim '
            + 'page after page. Marks are drawn over the page only: your PDF and your notes are not changed. '
            + 'Turn it on per viewer from the toolbar\'s display options, or with the "Toggle skim highlights" command.'
        );

    tab.addDropdownSetting('skimProvider', SKIM_PROVIDERS, () => tab.redisplay())
        .setName('Provider')
        .setDesc('Page text is sent to this service while skim mode is on.');

    tab.addTextSetting('skimModel', 'e.g. ~deepseek/deepseek-flash-latest')
        .setName('Model');

    tab.addTextSetting('skimEndpoint', 'http://localhost:11434/v1/chat/completions')
        .setName('Endpoint')
        .setDesc('The chat completions URL. A local server keeps page text on this machine.')
        .then((setting) => {
            tab.showConditionally(setting, () => tab.plugin.settings.skimProvider === 'openai-compatible');
        });

    tab.addTextSetting('skimApiKey', 'sk-...')
        .setName('API key')
        .setDesc('Stored in this plugin\'s data file as plain text, like every other setting. Do not use a key you would not keep in your vault.')
        .then((setting) => {
            setting.controlEl.querySelectorAll('input').forEach((input) => { input.type = 'password'; });
            tab.showConditionally(setting, () => providerNeedsApiKey(
                tab.plugin.settings.skimProvider, tab.plugin.settings.skimEndpoint
            ));
        });

    tab.addSliderSetting('skimDensityPercent', 5, 40, 1)
        .setName('How much of a page to mark')
        .setDesc('Share of the page\'s words, as a percentage. Models ignore this instruction, so PDF++ enforces it by dropping the least important phrases.');

    tab.addSliderSetting('skimPagesAhead', 0, 5, 1)
        .setName('Pages to prepare ahead')
        .setDesc('Analyzing the next pages while you read makes turning the page instant. Each page is one request.');

    tab.addSliderSetting('skimOpacity', 0.05, 0.6, 0.05)
        .setName('Mark opacity');

    tab.addTextSetting('skimReadingGoal', 'e.g. implementation details I can code from')
        .setName('What you are reading for')
        .setDesc('Optional. Steers which phrases get marked.');
}
