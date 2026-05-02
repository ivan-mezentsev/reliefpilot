// Bundles and re-exports the libraries used inside the ask_report webview.

import hljs from 'highlight.js';
import { marked } from 'marked';
import mermaid from 'mermaid';
// Full highlight.js build includes all languages.

type KatexRuntime = {
	renderToString(expression: string, options?: Record<string, unknown>): string;
};

const katex = require('katex') as KatexRuntime;

// Expose to window (webview script expects window.marked, window.hljs, window.katex & window.mermaid)
// We assign on globalThis to survive minification/changes.
// The actual webview HTML will just consume these via a single script tag.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).marked = marked;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).hljs = hljs;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).katex = katex;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).mermaid = mermaid;

// The file has no exports; side-effects attach libs to window.
export { };

