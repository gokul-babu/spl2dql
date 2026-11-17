/** Vite: a file imported with ?raw is its text. */
declare module '*?raw' {
  const text: string;
  export default text;
}

/** The release version, from packages/cli/package.json, set at build time (vite.config.ts). */
declare const __APP_VERSION__: string;
