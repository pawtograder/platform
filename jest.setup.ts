import "@testing-library/jest-dom";

// jsdom does not provide TextEncoder/TextDecoder, which some libraries (e.g. jose)
// reference as globals. Polyfill from Node's util.
import { TextEncoder, TextDecoder } from "util";
if (typeof global.TextEncoder === "undefined") {
  (global as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  (global as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

// jsdom does not provide structuredClone either. Chakra's styled-system builds
// its token dictionary with it at import time, so anything rendering a Chakra
// component fails to even load the module without this.
if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}
