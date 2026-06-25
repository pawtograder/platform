/* eslint-disable @typescript-eslint/no-explicit-any */
// Generic empty stub for browser-hostile packages we never actually invoke in
// the static preview (Monaco core, monaco-yaml, Sentry). Named Sentry/monaco
// helpers are no-ops so namespace calls don't crash if ever reached.
const noop = () => {};
export default {} as any;
export const captureException = noop;
export const captureMessage = noop;
export const withScope = noop;
export const addBreadcrumb = noop;
export const setContext = noop;
export const editor: any = {};
export const languages: any = {};
export const Range: any = class {};
export const configureMonacoYaml = noop;
