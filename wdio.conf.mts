import * as path from 'path';

/**
 * End-to-end tests that run inside a real Obsidian.
 *
 * The vitest suites under `tests/` cover what PDF++ writes into a PDF. They cannot
 * cover what they most need to: PDF++ works by monkey-patching Obsidian internals
 * that are not part of any public API, so the questions "does the patch still
 * apply?" and "does the viewer still reload?" can only be answered by running the
 * real app. wdio-obsidian-service downloads Obsidian and runs it sandboxed, so
 * these tests touch neither the developer's vault nor their config.
 *
 * On a headless machine, run under Xvfb: `xvfb-run -a pnpm test:e2e`.
 */
export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',
    specs: ['./tests/e2e/**/*.e2e.ts'],
    maxInstances: 1,

    capabilities: [{
        browserName: 'obsidian',
        // Defaults to the latest public release, which as of 2026-09-18 is 1.13.7.
        //
        // Obsidian 1.14 is still an insider build, so testing against it needs
        // `OBSIDIAN_VERSION=1.14.2` plus credentials in OBSIDIAN_EMAIL and
        // OBSIDIAN_PASSWORD (a .env file works), or a pre-download with
        // `npx obsidian-launcher download app -v 1.14.2`.
        //
        // Worth doing before trusting this suite about a version you actually run:
        // PDF++ patches Obsidian internals, and 1.14 has already moved some of them
        // (Page Preview's `instance.overrides` became `instance.options`, see 472b8b1).
        browserVersion: process.env.OBSIDIAN_VERSION ?? 'latest',
        'wdio:obsidianOptions': {
            installerVersion: process.env.OBSIDIAN_INSTALLER_VERSION ?? 'latest',
            // An insider build cannot be downloaded without credentials, but one that
            // is already installed can be loaded straight from its asar - which is how
            // to test against 1.14 locally:
            //   OBSIDIAN_APP_PATH="$HOME/Library/Application Support/obsidian/obsidian-1.14.2.asar" pnpm test:e2e
            ...(process.env.OBSIDIAN_APP_PATH ? { appPath: process.env.OBSIDIAN_APP_PATH } : {}),
            // Installs this repo's built plugin (manifest.json + main.js + styles.css).
            // Run a build first - the e2e suite tests the bundle, not the sources.
            plugins: ['.'],
            vault: 'tests/vaults/pdf-annotation',
        },
    }],

    services: ['obsidian'],
    reporters: ['obsidian'],

    cacheDir: path.resolve('.obsidian-cache'),

    mochaOpts: {
        ui: 'bdd',
        // Obsidian has to start and a PDF has to render.
        timeout: 120000,
    },

    logLevel: 'warn',
};
