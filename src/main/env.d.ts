// Build-time env vars baked into the main process by electron-vite (the
// MAIN_VITE_ prefix). Injected by the release workflow; absent in dev builds.
interface ImportMetaEnv {
  readonly MAIN_VITE_HERMES_API_URL?: string;
  readonly MAIN_VITE_HERMES_API_KEY?: string;
}

// Short hash of the commit being built, injected by electron.vite.config.ts
// (define). Empty string when git was unavailable at build time.
declare const __HERMES_COMMIT_HASH__: string;
