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
//
// Use v8's structured-clone serializer rather than a JSON round-trip: JSON
// cannot represent cycles, Map/Set or undefined, and Chakra's recipe objects
// (styled-system/use-recipe) hit all three — JSON.stringify returns undefined
// and JSON.parse then throws, so any component built from a recipe fails to
// render. v8.serialize implements the same structured-clone algorithm the real
// global uses.
import v8 from "node:v8";
if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (<T>(value: T): T => v8.deserialize(v8.serialize(value))) as typeof structuredClone;
}
