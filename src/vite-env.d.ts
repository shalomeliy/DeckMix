/// <reference types="vite/client" />

/**
 * Injected by `vite.config.ts`'s `define`, from `package.json`'s `version` at
 * build time. The only place the client reads its own version number — see
 * `tests/repo/client-version.test.ts`.
 */
declare const __APP_VERSION__: string

/** The commit the running copy was built from and its date ("747cb97 26/10"), or "build unknown" outside git. Set in `vite.config.ts`. */
declare const __APP_BUILD__: string
