import { isBinaryFile } from 'isbinaryfile';
import { randomUUID } from 'node:crypto';
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode';
import * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from 'vscode';
import { createSession, finalizeSession, getSession } from '../utils/ai_fetch_sessions';
import { env } from '../utils/env';
import { statusBarActivity } from '../utils/statusBar';

export type AiFetchUrlInput = {
    url: string;
    topic: string;
};

// Tool identifier used in logs and error envelopes
const TOOL_NAME = 'ai_fetch_url';

// Detect if a response body looks like HTML (content sniffing, no HTTP headers)

const looksLikeHtml = (text: string): boolean => {
    if (!text) return false;
    const sample = text.slice(0, 4096).toLowerCase();
    // Simplified signatures based on WHATWG MIME Sniffing guidance
    if (sample.includes('<!doctype html')) return true;
    if (sample.includes('<html')) return true;
    if (sample.includes('<head') && sample.includes('<body')) return true;
    if (sample.includes('<meta charset=')) return true;
    if (sample.includes('<title')) return true;
    // XHTML/XML carrying HTML
    if (sample.startsWith('<?xml') && sample.includes('<html')) return true;
    return false;
};

// Extract a slice of the HTML starting at the element referenced by the URL hash.
// Behavior:
// - No hash: returns original HTML.
// - Hash present: attempts to locate element with matching id or name.
// - On any failure (parser unavailable, body missing, anchor absent) throws an Error.
// This eliminates silent fallbacks and forces the caller to surface actionable feedback.
async function cropHtmlFromUrlAnchor(url: URL, html: string): Promise<string> {
    if (!url.hash || url.hash.length <= 1) {
        return html; // Fast path: no anchor requested.
    }

    // Decode fragment (anchor id). If decode fails keep raw value.
    const rawFragment = url.hash.slice(1);
    let anchorId = rawFragment;
    try { anchorId = decodeURIComponent(rawFragment); } catch { /* keep raw */ }
    if (!anchorId) {
        throw new Error('Anchor fragment is empty after decoding.');
    }

    if (!looksLikeHtml(html)) {
        throw new Error(`Anchor "${anchorId}" not found: content is not HTML-like.`);
    }

    // Load parse5 strictly; any failure surfaces as an error (no silent fallback).
    let parse: ((input: string, opts: any) => any) | undefined;
    try {
        const mod = await import('parse5');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        parse = (mod as any).parse ?? mod.default?.parse ?? (mod as any).parse;
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Unable to parse HTML to locate anchor "${anchorId}": ${reason}`);
    }
    if (typeof parse !== 'function') {
        throw new Error('parse5 parse function unavailable.');
    }

    const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });

    // Locate <body> for narrower traversal; if absent we cannot search meaningfully.
    const findBody = (node: any): any | undefined => {
        if (!node) return undefined;
        if (node.tagName === 'body') return node;
        const children: any[] = node.childNodes ?? [];
        for (const ch of children) {
            const res = findBody(ch);
            if (res) return res;
        }
        return undefined;
    };
    const htmlEl = (doc.childNodes ?? []).find((n: any) => n.tagName === 'html') ?? doc;
    const body = findBody(htmlEl);
    if (!body) {
        throw new Error(`Anchor "${anchorId}" not found: <body> not present.`);
    }

    // BFS search for the first element whose id or name matches anchorId.
    const queue: any[] = [body];
    while (queue.length) {
        const node = queue.shift();
        if (!node) continue;
        const attrs: Array<{ name: string; value: string }> = node.attrs ?? [];
        if (attrs.length) {
            const id = attrs.find(a => a.name === 'id')?.value;
            const nm = attrs.find(a => a.name === 'name')?.value;
            if (id === anchorId || nm === anchorId) {
                const loc = (node as any)?.sourceCodeLocation;
                const start: number | undefined = (loc?.startTag?.startOffset ?? loc?.startOffset);
                if (typeof start !== 'number') {
                    throw new Error(`Anchor "${anchorId}" found but start offset missing.`);
                }
                // Gather ancestor tags between body and the matched node (exclusive) to maintain structure.
                const ancestorTags: string[] = [];
                let p = (node as any).parentNode;
                while (p && p !== body && typeof p.tagName === 'string') {
                    ancestorTags.push(String(p.tagName));
                    p = p.parentNode;
                }
                ancestorTags.reverse();
                const openAncestors = ancestorTags.map(t => `<${t}>`).join('');
                let slice = html.slice(start);
                slice = slice.replace(/<\/(?:body|html)\b[^>]*>/gi, '');
                return `<!doctype html><html><head></head><body>${openAncestors}${slice}</body></html>`;
            }
        }
        if (Array.isArray(node.childNodes) && node.childNodes.length) {
            for (const ch of node.childNodes) queue.push(ch);
        }
    }

    // Anchor absent.
    throw new Error(`Anchor "${anchorId}" not found in document. Please locate the exact section (search docs) and retry.`);
}


const normalizeUrl = (raw?: string): URL => {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('The "url" parameter is required.');
    }

    try {
        return new URL(raw);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid URL provided: ${reason}`);
    }
};

const normalizeTopic = (raw?: string): string => {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('The "topic" parameter is required.');
    }
    return raw.trim();
};

// ---------------- Token counting & truncation utilities ----------------
// Evidence:
// - VS Code docs expose maxInputTokens and show a provideTokenCount heuristic (≈ length/4) in the Chat Provider guide.
// - OpenAI guidance recommends model tokenizers (e.g., tiktoken/cl100k) for GPT families.
// Approach:
// 1) Try GPT tokenizer when model id suggests GPT/OpenAI (optional, via eval('require') to avoid hard dependency).
// 2) Fallback to heuristic Math.ceil(length/4) per VS Code sample.
// 3) Binary-search truncation ensures content fits token budget.
// 4) Reserve small overhead to account for message wrapper tokens.

// Average characters per token (heuristic used in VS Code samples)
const APPROX_CHARS_PER_TOKEN = 4;
// Safety cushion to avoid hitting the hard cap exactly
const SAFETY_OVERHEAD_TOKENS = 32;

async function estimateTokens(text: string, modelId?: string): Promise<number> {
    const cleaned = text ?? '';
    if (!cleaned) return 0;
    try {
        if (modelId) {
            // Optional precise tokenizer for GPT-family models
            const req: any = (0, eval)('require');
            const mod = req?.('gpt-tokenizer');
            const encode: undefined | ((t: string) => number[]) = mod?.encode;
            if (encode) {
                return encode(cleaned).length;
            }
        }
    } catch {
        // ignore and fall back
    }
    // Heuristic fallback per docs
    return Math.ceil(cleaned.length / APPROX_CHARS_PER_TOKEN);
}

async function truncateToTokenBudget(original: string, budgetTokens: number, modelId?: string): Promise<{ text: string; truncated: boolean; tokenCount: number }> {
    if (budgetTokens <= 0) return { text: '', truncated: true, tokenCount: 0 };
    const fullTokens = await estimateTokens(original, modelId);
    if (fullTokens <= budgetTokens) return { text: original, truncated: false, tokenCount: fullTokens };
    let lo = 0, hi = original.length;
    let best = '';
    let bestTokens = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const slice = original.slice(0, mid);
        const t = await estimateTokens(slice, modelId);
        if (t <= budgetTokens) {
            best = slice; bestTokens = t; lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const marker = "\n\n[Content truncated to fit token budget]";
    const markerTokens = await estimateTokens(marker, modelId);
    if (bestTokens + markerTokens <= budgetTokens) {
        best += marker;
        bestTokens += markerTokens;
    }
    return { text: best, truncated: true, tokenCount: bestTokens };
}

async function prepareContentWithinBudget(content: string, systemPrompt: string, model: { id: string; maxInputTokens?: number }): Promise<{ text: string; truncated: boolean; usedTokens: number; budget: number }> {
    const maxInput = typeof model.maxInputTokens === 'number' && isFinite(model.maxInputTokens) ? model.maxInputTokens : 0;
    if (maxInput <= 0) return { text: content, truncated: false, usedTokens: 0, budget: 0 };
    const systemTokens = await estimateTokens(systemPrompt, model.id);
    const contentBudget = Math.max(0, maxInput - systemTokens - SAFETY_OVERHEAD_TOKENS);
    const contentTokens = await estimateTokens(content, model.id);
    if (contentTokens <= contentBudget) {
        return { text: content, truncated: false, usedTokens: contentTokens + systemTokens, budget: contentBudget };
    }
    const truncated = await truncateToTokenBudget(content, contentBudget, model.id);
    return { text: truncated.text, truncated: true, usedTokens: truncated.tokenCount + systemTokens, budget: contentBudget };
}

export class AiFetchUrlLanguageModelTool implements LanguageModelTool<AiFetchUrlInput> {
    private _pendingUids: string[] = [];

    private formatToolErrorMessage(error: unknown): string {
        const raw = error instanceof Error ? error.message : String(error);
        if (raw.startsWith(`${TOOL_NAME} error:`)) {
            return raw;
        }
        return `${TOOL_NAME} error: ${raw}`;
    }

    // Retrieve configuration settings once
    private getConfig() {
        const config = vscode.workspace.getConfiguration('reliefpilot');
        return {
            modelId: config.get<string>('AiFetchUrlModel'),
            promptTemplate: config.get<string>('AiFetchUrlPrompt'),
        };
    }

    // Single place to send successful tool responses
    private async sendSuccess(
        text: string,
        url: string,
        topic: string,
        token: CancellationToken,
        sessionUid?: string,
    ): Promise<LanguageModelToolResult> {
        const filtered = await this.filterTextWithAi(text, url, topic, token, sessionUid);
        return new LanguageModelToolResult([new LanguageModelTextPart(filtered)]);
    }

    // Single place to send error responses
    private sendError(error: unknown): LanguageModelToolResult {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${TOOL_NAME} error: ${message}`);
    }

    // Apply AI-based filtering using configured model and prompt
    private async filterTextWithAi(
        content: string,
        url: string,
        topic: string,
        token: CancellationToken,
        sessionUid?: string,
    ): Promise<string> {
        if (!vscode.lm) {
            throw new Error('Language model APIs are unavailable in this VS Code instance.');
        }

        const { modelId, promptTemplate } = this.getConfig();

        if (!modelId || modelId.trim().length === 0) {
            throw new Error('Missing configuration: reliefpilot.AiFetchUrlModel');
        }
        if (!promptTemplate || promptTemplate.trim().length === 0) {
            throw new Error('Missing configuration: reliefpilot.AiFetchUrlPrompt');
        }

        // Strict prompt formation per tutorial: use a first user message with the prompt,
        // then a user message with the actual content to process. Replace placeholders.
        const systemPrompt = promptTemplate
            .replaceAll('__AI_FETCH_URL_PROCESSED_URL__', url)
            .replaceAll('__AI_FETCH_URL_PROCESSED_TOPIC__', topic);

        // Resolve the model by id from settings
        const model = (await vscode.lm.selectChatModels({ id: modelId }))[0]!;

        // Prepare content to fit into model's input token budget together with the system prompt
        const prepared = await prepareContentWithinBudget(content, systemPrompt, model);
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(prepared.text),
        ];
        // Single execution of model request and streaming aggregation
        const requestOnce = async (): Promise<string> => {
            const chatResponse = await model.sendRequest(messages, {}, token);
            let filtered = '';
            for await (const fragment of chatResponse.text) {
                filtered += fragment;
                if (sessionUid) {
                    try {
                        const mod = await import('../utils/ai_fetch_sessions');
                        const s = mod.getSession(sessionUid);
                        if (s) { s.rightTextBuffer += fragment; s.rightTextEmitter.fire(fragment); }
                    } catch { /* ignore */ }
                }
            }
            return filtered;
        };

        const requestOnceWithCompletion = async (): Promise<string> => {
            const filtered = await requestOnce();
            if (sessionUid) {
                try {
                    const mod = await import('../utils/ai_fetch_sessions');
                    const s = mod.getSession(sessionUid);
                    if (s) {
                        s.finishedAt = Date.now();
                        s.rightDoneEmitter.fire();
                        mod.finalizeSession(sessionUid);
                    }
                } catch { /* ignore */ }
            }
            return filtered;
        };

        // Perform first attempt; on specific connection refused error do exactly one retry.
        try {
            return await requestOnceWithCompletion();
        } catch (err) {
            if (token.isCancellationRequested) {
                throw err; // don't retry if user cancelled
            }
            // Use documented API shape: err instanceof vscode.LanguageModelError (docs: language-model.md)
            // Inspect cause/message for the explicit network code.
            if (err instanceof vscode.LanguageModelError) {
                const causeMsg = err.cause instanceof Error ? err.cause.message : (typeof err.cause === 'string' ? err.cause : '');
                const combined = `${err.message}\n${causeMsg}`;
                // Pattern: "Error Code: net::ERR_CONNECTION_REFUSED" (user-provided example)
                const codeMatch = combined.match(/Error Code:\s*(\S+)/);
                if (codeMatch && codeMatch[1] === 'net::ERR_CONNECTION_REFUSED') {
                    // Single retry without delay or extra logic.
                    return await requestOnceWithCompletion();
                }
            }
            throw err;
        }
    }

    async invoke(
        options: LanguageModelToolInvocationOptions<AiFetchUrlInput>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        statusBarActivity.start(TOOL_NAME);

        // Always consume the pending UID early so prepareInvocation() link stays in sync even on errors.
        const uid = this._pendingUids.length > 0
            ? this._pendingUids.shift()!
            : randomUUID();

        // Reuse session created during prepareInvocation (status: pending), if any.
        let session = getSession(uid);

        try {
            const target = normalizeUrl(options.input?.url);
            const topic = normalizeTopic(options.input?.topic);
            // Resolve model metadata once for this invocation so it can be shown in the progress panel header.
            // These values are treated as required for the ai_fetch_url workflow.
            if (!vscode.lm) {
                throw new Error('Language model APIs are unavailable in this VS Code instance.');
            }
            const { modelId } = this.getConfig();
            if (!modelId || modelId.trim().length === 0) {
                throw new Error('Missing configuration: reliefpilot.AiFetchUrlModel');
            }
            const selected = (await vscode.lm.selectChatModels({ id: modelId }))[0];
            if (!selected) {
                throw new Error(`Configured model "${modelId}" is not available in this VS Code instance.`);
            }
            if (typeof selected.maxInputTokens !== 'number' || !isFinite(selected.maxInputTokens)) {
                throw new Error(`Selected model "${selected.id ?? modelId}" does not report a finite maxInputTokens value.`);
            }
            const sessionModelId = selected.id ?? modelId;
            const sessionModelMaxInputTokens = selected.maxInputTokens;

            // Compute an approximate character cap derived from the model's input token limit.
            // Use 95% of maxInputTokens and convert tokens→chars via heuristic (≈4 chars/token).
            const contentMaxLength = Math.max(1, Math.floor(sessionModelMaxInputTokens * APPROX_CHARS_PER_TOKEN * 0.95));

            // Reuse session created during prepareInvocation (status: pending) or create if missing.
            if (!session) {
                session = createSession(uid, target.toString(), topic, sessionModelId, sessionModelMaxInputTokens);
            } else {
                // Update placeholder metadata captured earlier.
                session.url = target.toString();
                session.topic = topic;
                session.modelId = sessionModelId;
                session.modelMaxInputTokens = sessionModelMaxInputTokens;
                session.status = 'running';
            }

            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(target, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                });

                if (!response.ok) {
                    throw new Error(`Request failed with status ${response.status} ${response.statusText}`);
                }

                // Read body as bytes and classify using isbinaryfile (no header heuristics)
                const rawBuffer = new Uint8Array(await response.arrayBuffer());
                const binary = await isBinaryFile(Buffer.from(rawBuffer));
                if (binary) {
                    return this.sendError(new Error('Binary content is not supported'));
                }

                // Decode textual content as UTF-8
                const bodyText = Buffer.from(rawBuffer).toString('utf8');

                // Anchor-aware preprocessing must happen BEFORE token-length capping
                const anchorCropped = await cropHtmlFromUrlAnchor(target, bodyText);

                let processedText = anchorCropped;
                if (looksLikeHtml(anchorCropped)) {
                    // Lazy-load @nanocollective/get-md to convert HTML to Markdown
                    const getMdModule = await import('@nanocollective/get-md');
                    const { convertToMarkdown } = getMdModule;

                    // Convert HTML to Markdown using @nanocollective/get-md
                    const result = await convertToMarkdown(anchorCropped, {
                        extractContent: false,
                        includeImages: false,
                        includeLinks: false,
                        includeMeta: false,
                        aggressiveCleanup: false,
                        maxLength: contentMaxLength,
                    });
                    processedText = result.markdown;
                } else {
                    // Plain-text path: cap by the same computed limit
                    if (processedText.length > contentMaxLength) {
                        processedText = processedText.slice(0, contentMaxLength) + "\n\n[Content truncated]";
                    }
                }

                // Emit left-column content for any subscribed progress panel and buffer it
                try { session.leftBuffer = processedText; session.leftEmitter.fire(processedText); } catch { /* ignore */ }

                return await this.sendSuccess(processedText, target.toString(), topic, token, uid);
            } finally {
                subscription.dispose();
            }
        } catch (error) {
            const message = this.formatToolErrorMessage(error);
            if (session) {
                // Surface the error in the progress panel (left column) and stop the stream timer.
                try {
                    session.leftBuffer = message;
                    session.leftEmitter.fire(session.leftBuffer);
                } catch { /* ignore */ }
                try {
                    finalizeSession(uid);
                } catch { /* ignore */ }
            }

            // Preserve existing error envelope format for chat/tool callers.
            throw new Error(message);
        } finally {
            statusBarActivity.end(TOOL_NAME);
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<AiFetchUrlInput>,
    ): PreparedToolInvocation {
        const { modelId } = this.getConfig();
        const url = options.input?.url ?? '<missing-url>';
        const topic = options.input?.topic ?? '<missing-topic>';
        // Use MarkdownString with HTML support for richer, formatted content.
        // Allowed HTML is sanitized by VS Code (see markdownRenderer.ts). Only a safe subset is rendered.
        const md = new vscode.MarkdownString(undefined, true /* supportThemeIcons */);
        md.supportHtml = true; // allow safe raw HTML (e.g., <span style="color:#fff;background-color:#000">)
        md.isTrusted = true;   // required so inline <span> is preserved by sanitizer

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);

        // Nicely formatted invocation info (title + details)
        md.appendMarkdown(`Relief Pilot · **ai_fetch_url**\n`);
        md.appendMarkdown(`- Model: \`${modelId ?? '—'}\`  \n`);
        md.appendMarkdown(`- URL: ${url}  \n`);
        md.appendMarkdown(`- Topic: \`${topic}\`\n\n`);

        // Generate UID and remember for invoke(); embed in command link
        const uid = randomUUID();
        this._pendingUids.push(uid);

        // Early session creation (modelMaxInputTokens unknown yet -> 0 placeholder)
        try {
            createSession(uid, url, topic, modelId ?? '—', 0); // status="pending" set internally
        } catch { /* swallow early creation errors */ }

        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }));
        md.appendMarkdown(`[Show progress](command:reliefpilot.aiFetchUrl.showProgress?${cmdArgs})`);

        return {
            invocationMessage: md,
        };
    }
}
