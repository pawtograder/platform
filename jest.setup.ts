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
