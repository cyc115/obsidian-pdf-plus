import { Setting } from 'obsidian';

import { PDFPlusSettingTab } from 'settings';
import {
    PROVIDER_DEFAULT_ENDPOINTS, SKIM_PROVIDERS, SkimProviderId, providerNeedsApiKey, providerUsesEndpoint
} from './llm';


/**
 * The "Skim highlights" section of the settings tab.
 *
 * Kept in its own file so the feature does not add to `settings.ts`, which is already the
 * largest file in the repository and the one most likely to conflict with upstream.
 */
export function addSkimSettings(tab: PDFPlusSettingTab): void {
    // The settings tab is built by one long run of statements, so anything thrown here would
    // silently swallow every section below it. Show the failure instead of hiding it.
    try {
        buildSkimSettings(tab);
    } catch (error) {
        console.error('PDF++: the Skim highlights settings section failed to render.', error);
        tab.writeRenderStatus(`skim section: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        tab.addSetting()
            .setName('Skim highlights: this section failed to render')
            .setDesc(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
            .then((setting) => setting.settingEl.addClass('pdf-plus-skim-settings-error'));
    }
}


function buildSkimSettings(tab: PDFPlusSettingTab): void {
    tab.addHeading('Skim highlights', 'skim', 'lucide-highlighter')
        .setDesc(
            'A model reads the page you are on and marks the phrases worth seeing, so you can skim '
            + 'page after page. Marks are drawn over the page only: your PDF and your notes are not changed.'
        );

    tab.addToggleSetting('skimEnabled', (value) => {
        // Turning it off should take the marks off the pages that are already showing them.
        if (!value) tab.plugin.lib.workspace.iteratePDFViewerChild((child) => child.skim?.stop());
        tab.redisplay();
    })
        .setName('Enable skim highlights')
        .setDesc(
            'Off by default because it sends the text of the pages you read to the service below. '
            + 'Once on, turn marks on per viewer from the toolbar\'s display options, or with the '
            + '"Toggle skim highlights" command.'
        );

    // Everything below configures a feature that is off, so it only gets in the way until the
    // toggle above is on. Each setting gets exactly one visibility condition.
    const enabled = () => tab.plugin.settings.skimEnabled;

    const alwaysWhenEnabled: Setting[] = [];

    alwaysWhenEnabled.push(
        tab.addDropdownSetting('skimProvider', SKIM_PROVIDERS, (value) => {
            moveToProviderDefaultEndpoint(tab, value as SkimProviderId);
            tab.redisplay();
        })
            .setName('Provider')
            .setDesc('Page text is sent to this service while skim mode is on.')
    );

    const endpointSetting = tab.addTextSetting('skimEndpoint', PROVIDER_DEFAULT_ENDPOINTS.openrouter)
        .setName('Endpoint')
        .setDesc(
            'The OpenAI-compatible chat completions URL. Switching provider fills this in; '
            + 'edit it to point at any other compatible server. A localhost URL keeps page text on this machine.'
        );

    alwaysWhenEnabled.push(
        tab.addTextSetting('skimModel', 'e.g. ~deepseek/deepseek-flash-latest')
            .setName('Model ID')
            .setDesc('The model name exactly as the provider spells it.')
    );

    const apiKeySetting = tab.addTextSetting('skimApiKey', 'sk-...')
        .setName('API key')
        .setDesc('Stored in this plugin\'s data file as plain text, like every other setting. Do not use a key you would not keep in your vault.')
        .then((setting) => {
            setting.controlEl.querySelectorAll('input').forEach((input) => { input.type = 'password'; });
        });

    alwaysWhenEnabled.push(
        tab.addSliderSetting('skimDensityPercent', 5, 40, 1)
            .setName('How much of a page to mark')
            .setDesc('Share of the page\'s words, as a percentage. Models ignore this instruction, so PDF++ enforces it by dropping the least important phrases.')
    );

    alwaysWhenEnabled.push(
        tab.addSliderSetting('skimPagesAhead', 0, 5, 1)
            .setName('Pages to prepare ahead')
            .setDesc('Analyzing the next pages while you read makes turning the page instant. Each page is one request.')
    );

    alwaysWhenEnabled.push(
        tab.addSliderSetting('skimOpacity', 0.05, 0.6, 0.05)
            .setName('Mark opacity')
    );

    alwaysWhenEnabled.push(
        tab.addTextSetting('skimReadingGoal', 'e.g. implementation details I can code from')
            .setName('What you are reading for')
            .setDesc('Optional. Steers which phrases get marked.')
    );

    tab.showConditionally(alwaysWhenEnabled, enabled);
    // These two are narrower: they also depend on which provider is chosen.
    tab.showConditionally(endpointSetting, () => enabled() && providerUsesEndpoint(tab.plugin.settings.skimProvider));
    tab.showConditionally(apiKeySetting, () => enabled() && providerNeedsApiKey(
        tab.plugin.settings.skimProvider, tab.plugin.settings.skimEndpoint
    ));
}

/**
 * Point the endpoint box at the newly chosen provider, unless it holds a URL that was typed
 * by hand rather than one PDF++ filled in.
 */
function moveToProviderDefaultEndpoint(tab: PDFPlusSettingTab, provider: SkimProviderId): void {
    const current = tab.plugin.settings.skimEndpoint.trim();
    const isUntouched = !current || Object.values(PROVIDER_DEFAULT_ENDPOINTS).includes(current);
    if (!isUntouched) return;

    const next = PROVIDER_DEFAULT_ENDPOINTS[provider];
    if (!next || next === current) return;

    tab.plugin.settings.skimEndpoint = next;
    tab.plugin.saveSettings();
}
