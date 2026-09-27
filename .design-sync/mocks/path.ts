/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal browser stand-in for node's `path` (rubric-sidebar uses basename/extname/etc).
function basename(p: string, ext?: string) { let b = (p || "").split("/").pop() || ""; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; }
function dirname(p: string) { const i = (p || "").lastIndexOf("/"); return i <= 0 ? "." : p.slice(0, i); }
function extname(p: string) { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; }
function join(...parts: string[]) { return parts.filter(Boolean).join("/").replace(/\/+/g, "/"); }
const path: any = { basename, dirname, extname, join, sep: "/" };
export default path;
export { basename, dirname, extname, join };
