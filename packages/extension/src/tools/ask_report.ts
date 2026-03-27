import { randomUUID } from 'node:crypto'
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { askReportHistory } from '../utils/ask_report_history'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'
import { createWebviewVoiceInputController } from '../utils/webviewVoiceInputController'

// Event emitter for Telegram integration: fires when a new ask_report is created
const _onAskReportCreated = new vscode.EventEmitter<{
    id: string
    topicName: string
    message: string
    predefinedOptions?: string[]
}>()
export const onAskReportCreated = _onAskReportCreated.event

export type AskReportOptions = {
    title?: string
    markdown: string
    initialValue?: string
    predefinedOptions?: string[]
    readOnly?: boolean

    startPaused?: boolean

    preselectCustom?: boolean
    historyId?: string
}

export type AskUserResult = {
    decision: 'Submit' | 'Cancel'
    value: string
    timeout?: boolean
}

export type AskReportInput = {
    topicName: string
    message: string
    predefinedOptions?: string[]
}

export type ExternalAskReportResolution = {
    decision: 'Submit' | 'Cancel'
    value: string
    source: 'telegram'
}

type PendingAskReportResolver = {
    resolveExternally: (result: ExternalAskReportResolution) => boolean
}

let activeAskReportPanel: vscode.WebviewPanel | undefined
const pendingAskReportResolvers = new Map<string, PendingAskReportResolver>()

export function getActiveAskReportPanel(): vscode.WebviewPanel | undefined {
    return activeAskReportPanel
}

export function resolveAskReportFromTelegram(reportId: string, value: string): 'resolved' | 'not-found' | 'already-settled' {
    const resolver = pendingAskReportResolvers.get(reportId)
    if (!resolver) {
        return 'not-found'
    }

    const resolved = resolver.resolveExternally({
        decision: 'Submit',
        value,
        source: 'telegram',
    })

    return resolved ? 'resolved' : 'already-settled'
}

export async function askReport(opts: AskReportOptions): Promise<AskUserResult> {
    const title = opts.title ?? 'Ask Report'
    const voiceInputEnabled = opts.readOnly !== true

    // Read timeout from settings early because initial webview rendering must not depend on postMessage timing.
    const timeout = vscode.workspace
        .getConfiguration('reliefpilot')
        .get<number>('askReportTimeoutSeconds', 60)

    // Resolve extension media folder for localResourceRoots
    const extensionUri = env.extensionUri
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')

    const panel = vscode.window.createWebviewPanel(
        'reliefpilot.askReport',
        title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [mediaRoot],
        },
    )

    activeAskReportPanel = panel

    // Bind this panel instance to history entry (if any) to avoid duplicates
    if (opts.historyId) {
        try {
            const entry = askReportHistory.getById(opts.historyId)
            if (entry) {
                entry.panel = panel
            }
        } catch { /* ignore */ }
    }

    // Set the webview tab icon depending on mode:
    // - Active (interactive) report: colored icon.png
    // - Read-only (opened from history): monochrome icon_mono.png
    try {
        const iconFile = opts.readOnly ? 'icon_mono.png' : 'icon.png'
        const iconUri = vscode.Uri.joinPath(extensionUri, iconFile)
        panel.iconPath = iconUri
    } catch {
        // ignore icon assignment errors
    }

    // Prepare resource URIs for webview
    const cssUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'ask_report.css'),
    )
    const markdownDepsUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'markdown-deps.js'),
    )
    const markdownEnhanceUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'markdown-enhance.js'),
    )
    const hljsCssUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'highlight.github.css'),
    )
    const voiceInputUri = voiceInputEnabled
        ? panel.webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'media', 'voice-input.js'),
        )
        : undefined

    // Generate secure HTML with CSP, connect marked.min.js via asWebviewUri, and build UI containers.
    const nonce = generateNonce()
    const csp = [
        "default-src 'none'",
        `img-src ${panel.webview.cspSource} blob: data:`,
        `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ')

    // Inline bootstrap payload into HTML to avoid relying on a single postMessage(init) that can be dropped.
    const bootstrapPayload = {
        markdown: opts.markdown,
        initialValue: opts.initialValue ?? '',
        options: opts.predefinedOptions ?? [],
        timeout: opts.readOnly ? 0 : timeout,
        readonly: opts.readOnly === true,

        // Halt for Feedback integration flags
        startPaused: opts.startPaused === true,
        preselectCustom: opts.preselectCustom === true,
    }

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="${csp}" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <link rel="stylesheet" href="${hljsCssUri}" />
        <title>${escapeHtml(title)}</title>
    </head>
    <body>
        <div class="askreport__progress" aria-hidden="true">
            <div id="progressLine" class="askreport__progress-line"></div>
        </div>
        <header class="askreport__header" role="toolbar" aria-label="Ask report toolbar">
            <button id="copyBtn" class="btn secondary icon-btn" aria-label="Copy content" title="Copy"></button>
            <button id="saveBtn" class="btn secondary icon-btn" aria-label="Save" title="Save"></button>
            <div class="spacer"></div>
            <button id="pauseBtn" class="btn secondary icon-btn" aria-label="Pause timer" title="Pause"></button>
            <span id="timer" class="timer" aria-live="polite">0</span>
        </header>
        <main class="askreport__main">
            <section id="markdown" class="markdown" aria-label="Markdown content" tabindex="0"></section>
        </main>
        <footer class="askreport__footer askreport__dock" id="bottomDock">
            <div class="controls">
                <fieldset id="optionsFieldset" class="options" aria-label="Ask report options"></fieldset>
                <div class="textarea-mic-wrap" style="position:relative;">
                  <textarea id="customText" class="textarea" aria-label="Custom response" placeholder="Type your response…"></textarea>
                                    ${voiceInputEnabled ? `<button id="micBtn" class="btn secondary voice-input__button" aria-label="Voice input" title="Voice input" style="position:absolute;bottom:6px;right:6px;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm0 2a2 2 0 0 0-2 2v6a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2zm-7 8h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.93V21h-4v-3.07A7 7 0 0 1 5 11z"/>
                                        </svg>
                                    </button>` : ''}
                </div>
            </div>
            <div class="actions">
                <button id="submitBtn" class="btn primary" aria-label="Submit" disabled>Submit</button>
                <button id="cancelBtn" class="btn" aria-label="Cancel">Cancel</button>
            </div>
        </footer>
        <script nonce="${nonce}">const BOOTSTRAP = ${serializeForHtmlScriptTag(bootstrapPayload)};</script>
    <script nonce="${nonce}" src="${markdownDepsUri}"></script>
    <script nonce="${nonce}" src="${markdownEnhanceUri}"></script>
        <script nonce="${nonce}">
            // Webview script — no external deps; relies on VS Code API provided object
            const vscode = acquireVsCodeApi();
            /** @type {{ markdown: string; initialValue?: string; options?: string[]; timeout?: number; readonly?: boolean; startPaused?: boolean; preselectCustom?: boolean }} */
            let initData = { markdown: '', initialValue: '', options: [], timeout: 0, readonly: false };

            // cache DOM
            const el = {
                markdown: document.getElementById('markdown'),
                copyBtn: document.getElementById('copyBtn'),
                saveBtn: document.getElementById('saveBtn'),
                pauseBtn: document.getElementById('pauseBtn'),
                timer: document.getElementById('timer'),
                progress: document.getElementById('progressLine'),
                options: document.getElementById('optionsFieldset'),
                textarea: document.getElementById('customText'),
                submit: document.getElementById('submitBtn'),
                cancel: document.getElementById('cancelBtn'),
                    dock: document.getElementById('bottomDock'),
            };

            let selected = '';
            let usingCustom = false;
            /** @type {number} */
            let remaining = 0;
            /** @type {boolean} */
            let paused = false;
            /** @type {number | undefined} */
            let intervalId = undefined;

            /** @type {boolean} */
            let markdownLinkHandlerAttached = false;

            // SVG icon helpers
            function setCopyIcon() {
                if (!el.copyBtn) return;
                el.copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\
                        <path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z" fill="currentColor"/>\
                        <path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z" fill="currentColor"/>\
                    </svg>';
            }
            function setSaveIcon() {
                if (!el.saveBtn) return;
                // Floppy disk outline icon to match outline style
                el.saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\
                        <path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>\
                        <path d="M9 3h6v6H9V3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>\
                        <path d="M7 21v-6h10v6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>\
                    </svg>';
            }
            function setPausePlayIcon() {
                if (!el.pauseBtn) return;
                if (paused) {
                    // show play icon
                    el.pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\
                            <path d="M8 5v14l11-7L8 5z" fill="currentColor"/>\
                        </svg>';
                } else {
                    // show pause icon
                    el.pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\
                            <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/>\
                        </svg>';
                }
            }

            function renderTimer() {
                if (!initData.timeout || initData.timeout <= 0) {
                    el.timer.textContent = '';
                    el.pauseBtn.style.display = 'none';
                    if (el.progress) { el.progress.style.width = '0%'; }
                    return;
                }
                // Only digits (no label or unit)
                el.timer.textContent = String(Math.max(0, remaining));
                el.pauseBtn.style.display = '';
                // update progress line: 100% -> 0%
                if (el.progress && typeof initData.timeout === 'number' && initData.timeout > 0) {
                    const pct = Math.max(0, Math.min(100, Math.round((remaining / initData.timeout) * 100)));
                    el.progress.style.width = pct + '%';
                }
                // ensure icon reflects state
                setPausePlayIcon();
            }

            function stopTimer() {
                if (intervalId !== undefined) {
                    clearInterval(intervalId);
                    intervalId = undefined;
                }
            }

            function disableAllInputs() {
                try { el.submit.disabled = true; } catch {}
                try { el.cancel.disabled = true; } catch {}
                try { el.textarea.disabled = true; } catch {}
                try { (el.options).setAttribute('disabled', ''); } catch {}
                try { el.pauseBtn.disabled = true; } catch {}
            }

            function startTimer() {
                stopTimer();
                if (!initData.timeout || initData.timeout <= 0) {
                    el.pauseBtn.style.display = 'none';
                    renderTimer();
                    return;
                }
                if (remaining <= 0) remaining = initData.timeout;
                intervalId = setInterval(() => {
                    if (paused) {
                        return;
                    }
                    remaining -= 1;
                    renderTimer();
                    if (remaining <= 0) {
                        stopTimer();
                        // Deactivate inputs and notify extension
                        disableAllInputs();
                        vscode.postMessage({ type: 'timeout' });
                    }
                }, 1000);
                renderTimer();
            }
            /** Enable/disable submit based on current selection rules */
            function updateSubmitState() {
                if (!initData.options || initData.options.length === 0) {
                    // Only textarea mode
                    const valid = (el.textarea.value || '').trim().length > 0;
                    el.submit.disabled = !valid;
                    return;
                }
                if (usingCustom) {
                    el.submit.disabled = ((el.textarea.value || '').trim().length === 0);
                    return;
                }
                el.submit.disabled = (selected === '');
            }

            function updateTextareaVisibility() {
                // Explicitly control display instead of relying on stylesheet defaults
                // to avoid being overridden by "textarea { display: none; }" in CSS.
                if (!initData.options || initData.options.length === 0) {
                    el.textarea.style.display = 'block';
                    return;
                }
                el.textarea.style.display = usingCustom ? 'block' : 'none';
            }

            function activateCustomOption() {
                const custom = el.options.querySelector('#opt_custom');
                if (custom) {
                    /** @type {HTMLInputElement} */ (custom).checked = true;
                    custom.dispatchEvent(new Event('change'));
                    return;
                }

                usingCustom = true;
                selected = '';
                updateSubmitState();
                updateTextareaVisibility();
                updateDockHeightVar();
                try { el.textarea.focus(); } catch {}
                persistState();
            }

                function updateDockHeightVar() {
                    try {
                        const root = document.documentElement;
                        const h = el.dock ? (el.dock.getBoundingClientRect().height || 0) : 0;
                        root.style.setProperty('--askreport-dock-height', Math.max(96, Math.round(h)) + 'px');
                    } catch {}
                }

            function renderOptions(options) {
                el.options.innerHTML = '';
                if (!options || options.length === 0) {
                    el.options.style.display = 'none';
                    usingCustom = true; // only textarea path
                    updateTextareaVisibility();
                        updateDockHeightVar();
                    return;
                }
                el.options.style.display = '';
                const group = document.createElement('div');
                group.className = 'radio-group';
                options.forEach((opt, idx) => {
                    const id = 'opt_' + idx;
                    const label = document.createElement('label');
                    label.className = 'radio';
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = 'ask_report_option';
                    input.id = id;
                    input.value = opt;
                    input.addEventListener('change', () => {
                        usingCustom = false;
                        selected = input.value;
                        updateSubmitState();
                        updateTextareaVisibility();
                        updateDockHeightVar();
                        persistState();
                    });
                    const span = document.createElement('span');
                    span.textContent = opt;
                    label.appendChild(input);
                    label.appendChild(span);
                    group.appendChild(label);
                });
                // Custom option (always last)
                const customLabel = document.createElement('label');
                customLabel.className = 'radio';
                const customInput = document.createElement('input');
                customInput.type = 'radio';
                customInput.name = 'ask_report_option';
                customInput.id = 'opt_custom';
                customInput.value = '__CUSTOM__';
                customInput.addEventListener('change', () => {
                    usingCustom = true;
                    selected = '';
                    el.textarea.focus();
                    updateSubmitState();
                    updateTextareaVisibility();
                    updateDockHeightVar();
                    persistState();
                });
                const customSpan = document.createElement('span');
                customSpan.textContent = 'Custom';
                customLabel.appendChild(customInput);
                customLabel.appendChild(customSpan);
                group.appendChild(customLabel);
                el.options.appendChild(group);

                // Preselect first predefined option (matches reference UX)
                const first = group.querySelector('input[type=radio][id^="opt_"]');
                if (first) {
                    /** @type {HTMLInputElement} */ (first).checked = true;
                    selected = /** @type {HTMLInputElement} */ (first).value;
                    usingCustom = false;
                    // Ensure any listeners depending on change are fired
                    first.dispatchEvent(new Event('change'));
                } else {
                    updateSubmitState();
                    updateTextareaVisibility();
                    updateDockHeightVar();
                }
            }

            function focusFirst() {
                const firstRadio = el.options.querySelector('input[type=radio]');
                if (firstRadio) {
                    /** @type {HTMLInputElement} */ (firstRadio).focus();
                    return;
                }
                el.textarea.focus();
            }

            function getSubmitValue() {
                if (!initData.options || initData.options.length === 0) {
                    return (el.textarea.value || '').trim();
                }
                if (usingCustom) {
                    return (el.textarea.value || '').trim();
                }
                return selected;
            }

        function sendSubmit() {
                const value = getSubmitValue();
                if (!el.submit.disabled) {
                    stopTimer();
            persistState();
                    vscode.postMessage({ type: 'submit', value });
                }
            }

            function sendCancel() {
                stopTimer();
                persistState();
                vscode.postMessage({ type: 'cancel' });
            }

            // Keyboard handler: Ctrl/Cmd+Enter for submit
            document.addEventListener('keydown', (ev) => {
                const isSubmitCombo = (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey));
                if (isSubmitCombo) {
                    ev.preventDefault();
                    sendSubmit();
                }
            });

            // Local UI events
            el.textarea.addEventListener('input', () => {
                updateSubmitState();
                persistState();
                    updateDockHeightVar();
            });
            el.copyBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'copy', text: initData.markdown || '' });
                // brief ui feedback
                el.copyBtn.classList.add('active');
                setTimeout(() => el.copyBtn.classList.remove('active'), 300);
            });
            el.saveBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'save', text: initData.markdown || '' });
                el.saveBtn.classList.add('active');
                setTimeout(() => el.saveBtn.classList.remove('active'), 300);
            });
            el.pauseBtn.addEventListener('click', () => {
                if (!initData.timeout || initData.timeout <= 0) return;
                if (!paused) {
                    paused = true;
                    el.pauseBtn.setAttribute('aria-label', 'Resume timer');
                    el.pauseBtn.setAttribute('title', 'Resume');
                } else {
                    paused = false;
                    el.pauseBtn.setAttribute('aria-label', 'Pause timer');
                    el.pauseBtn.setAttribute('title', 'Pause');
                }
                setPausePlayIcon();
                renderTimer();
                persistState();
            });
            el.submit.addEventListener('click', () => sendSubmit());
            el.cancel.addEventListener('click', () => sendCancel());

                // Recompute reserved space when viewport changes
                window.addEventListener('resize', () => updateDockHeightVar());

            function attachMarkdownLinkInterceptorOnce() {
                if (markdownLinkHandlerAttached) return;
                markdownLinkHandlerAttached = true;
                // Intercept clicks on links to send openExternal
                el.markdown.addEventListener('click', (e) => {
                    const target = e.target;
                    if (target && target.tagName === 'A') {
                        e.preventDefault();
                        const href = target.getAttribute('href') || '';
                        if (href) {
                            vscode.postMessage({ type: 'openExternal', url: href });
                        }
                    }
                });
            }

            function applyInit(payload) {
                initData = payload || initData;
                try {
                    if (window.ReliefPilotMarkdownEnhancer) {
                        window.ReliefPilotMarkdownEnhancer.render(el.markdown, initData.markdown || '', (text) => { try { vscode.postMessage({ type: 'copy', text }); } catch {} });
                    } else if (window.marked) {
                        try { el.markdown.innerHTML = window.marked.parse(initData.markdown || ''); } catch { el.markdown.textContent = initData.markdown || ''; }
                    } else {
                        el.markdown.textContent = initData.markdown || '';
                    }
                } catch { el.markdown.textContent = initData.markdown || ''; }

                // Try restoring from saved state if present
                const savedState = vscode.getState() || {};

                // Base textarea value from init unless saved has a specific value
                el.textarea.value = (typeof savedState.textareaValue === 'string')
                    ? savedState.textareaValue
                    : (initData.initialValue || '');

                // Hide textarea by default until options logic decides otherwise
                el.textarea.style.display = 'none';
                renderOptions(initData.options || []);

                // Restore selected option/custom if saved
                if (savedState && (savedState.usingCustom === true || typeof savedState.selected === 'string')) {
                    if (savedState.usingCustom) {
                        const custom = el.options.querySelector('#opt_custom');
                        if (custom) {
                            /** @type {HTMLInputElement} */ (custom).checked = true;
                            usingCustom = true;
                            selected = '';
                        }
                    } else if (typeof savedState.selected === 'string' && savedState.selected) {
                        const match = Array.from(el.options.querySelectorAll('input[type=radio]'))
                            .find((n) => /** @type {HTMLInputElement} */ (n).value === savedState.selected);
                        if (match) {
                            /** @type {HTMLInputElement} */ (match).checked = true;
                            usingCustom = false;
                            selected = /** @type {HTMLInputElement} */ (match).value;
                        }
                    }
                }

                // Halt for Feedback integration:
                // - preselect Custom when requested (even if the first option was auto-selected)
                // - start timer paused when requested
                if (!initData.readonly) {
                    if (initData.preselectCustom === true) {
                        activateCustomOption();
                    }
                }

                updateSubmitState();
                updateTextareaVisibility();

                // When forcing Custom, ensure focus is on textarea and submit state is recalculated.
                if (!initData.readonly && initData.preselectCustom === true) {
                    try { el.textarea.focus(); } catch {}
                    updateSubmitState();
                    updateTextareaVisibility();
                }

                // Focus management
                focusFirst();

                // Init timer (restore remaining/pause if saved)
                const savedRemaining = typeof savedState.remaining === 'number' ? savedState.remaining : undefined;
                const savedPaused = typeof savedState.paused === 'boolean' ? savedState.paused : undefined;
                remaining = (typeof savedRemaining === 'number' && savedRemaining > 0)
                    ? savedRemaining
                    : ((typeof initData.timeout === 'number' && initData.timeout > 0) ? initData.timeout : 0);
                paused = savedPaused ?? false;

                if (!initData.readonly && initData.startPaused === true) {
                    paused = true;
                }

                // Setup pause button initial state
                el.pauseBtn.setAttribute('aria-label', paused ? 'Resume timer' : 'Pause timer');
                el.pauseBtn.setAttribute('title', paused ? 'Resume' : 'Pause');
                setCopyIcon();
                setSaveIcon();
                setPausePlayIcon();

                // Apply read-only UI mode when requested: disable all controls and hide timer UI
                if (initData.readonly) {
                    try { el.pauseBtn.style.display = 'none'; } catch {}
                    try { el.timer.style.display = 'none'; } catch {}
                    try { const bar = document.querySelector('.askreport__progress'); if (bar) bar.setAttribute('style', 'display: none;'); } catch {}
                    disableAllInputs();
                    // Ensure no timer
                    stopTimer();
                } else {
                    startTimer();
                }

                attachMarkdownLinkInterceptorOnce();

                // Persist initial state after rendering
                persistState();
            }

            window.addEventListener('message', (event) => {
                const msg = event.data;
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'activateCustom') {
                    activateCustomOption();
                    return;
                }
                if (msg.type !== 'init') return;
                applyInit(msg.payload);
            });

            // Bootstrap initial render from inlined payload (does not depend on extension-to-webview messaging timing)
            const bootstrap = (typeof BOOTSTRAP !== 'undefined') ? BOOTSTRAP : undefined;
            if (bootstrap) {
                applyInit(bootstrap);
            }

            function persistState() {
                try {
                    vscode.setState({
                        initData,
                        selected,
                        usingCustom,
                        textareaValue: el.textarea.value || '',
                        remaining,
                        paused,
                    });
                } catch {}
            }

            // (Markdown decoration helpers moved to shared media/markdown-enhance.js)

        </script>
    ${voiceInputEnabled && voiceInputUri
            ? `<script nonce="${nonce}" src="${voiceInputUri}"></script>
    <script nonce="${nonce}">window.ReliefPilotVoiceInput.init({ micBtn: document.getElementById('micBtn'), textarea: el.textarea, vscode: vscode });</script>`
            : ''}
    </body>
</html>`

    // Return a promise that resolves based on webview messages or panel disposal
    return await new Promise<AskUserResult>((resolve) => {
        let settled = false
        const voiceController = createWebviewVoiceInputController({
            panel,
            enableVoiceInput: voiceInputEnabled,
            onBeforeStart: () => {
                void panel.webview.postMessage({ type: 'activateCustom' })
            },
        })
        const finalize = (res: AskUserResult) => {
            if (!settled) {
                settled = true
                if (opts.historyId) {
                    pendingAskReportResolvers.delete(opts.historyId)
                }
                voiceController.dispose()
                try { panel.dispose() } catch { /* noop */ }
                resolve(res)
            }
        }

        if (opts.historyId && !opts.readOnly) {
            pendingAskReportResolvers.set(opts.historyId, {
                resolveExternally: (result) => {
                    if (settled) {
                        return false
                    }

                    finalize({
                        decision: result.decision,
                        value: result.value,
                    })
                    return true
                },
            })
        }

        const disposables: vscode.Disposable[] = []

        // Handle messages from webview
        disposables.push(
            panel.webview.onDidReceiveMessage(async (msg: any) => {
                if (voiceController.handleMessage(msg)) {
                    return
                }

                if (!msg || typeof msg !== 'object') return
                switch (msg.type) {
                    case 'submit': {
                        const value = typeof msg.value === 'string' ? msg.value : ''
                        finalize({ decision: 'Submit', value })
                        return
                    }
                    case 'cancel': {
                        finalize({ decision: 'Cancel', value: '' })
                        return
                    }
                    case 'timeout': {
                        finalize({ decision: 'Cancel', value: '', timeout: true })
                        return
                    }
                    case 'openExternal': {
                        const url = typeof msg.url === 'string' ? msg.url : ''
                        if (url) {
                            try {
                                await vscode.env.openExternal(vscode.Uri.parse(url))
                            } catch {
                                // ignore
                            }
                        }
                        return
                    }
                    case 'copy': {
                        const text = typeof msg.text === 'string' ? msg.text : ''
                        try {
                            await vscode.env.clipboard.writeText(text)
                        } catch {
                            // ignore clipboard errors
                        }
                        return
                    }
                    case 'save': {
                        const text = typeof msg.text === 'string' ? msg.text : ''
                        try {
                            const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text })
                            await vscode.window.showTextDocument(doc)
                        } catch {
                            // ignore errors silently (no notifications)
                        }
                        return
                    }
                    default:
                        return
                }
            }),
        )

        // Resolve Cancel if panel is closed without decision
        disposables.push(
            panel.onDidDispose(() => {
                voiceController.dispose()
                if (opts.historyId) {
                    pendingAskReportResolvers.delete(opts.historyId)
                }
                if (activeAskReportPanel === panel) activeAskReportPanel = undefined
                if (opts.historyId) {
                    try {
                        const entry = askReportHistory.getById(opts.historyId)
                        if (entry) entry.panel = undefined
                    } catch { /* ignore */ }
                }
                if (!settled) {
                    settled = true
                    resolve({ decision: 'Cancel', value: '' })
                }
                disposables.forEach((d) => {
                    try { d.dispose() } catch { /* noop */ }
                })
            }),
        )

    })
}

export class AskReportLanguageModelTool
    implements LanguageModelTool<AskReportInput> {
    private _pendingUids: string[] = []
    async invoke(
        options: LanguageModelToolInvocationOptions<AskReportInput>,
        _token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // Show spinner while ask_report is active
        statusBarActivity.start('ask_report')
        try {
            const input = options.input

            if (!input || typeof input.topicName !== 'string' || typeof input.message !== 'string') {
                throw new Error('ask_report requires "topicName" and "message" strings.')
            }

            // Resolve UID from prepareInvocation (FIFO), or generate new if direct call
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()

            // Halt for Feedback integration (special rules for ask_report):
            // 1) If global state is paused: start ask_report's timer paused in the WebView and release global state back to running.
            // 2) If global state is declined: preselect Custom and prefill it with feedback; also reset global state back to running.
            const haltSnapshot = haltForFeedbackController.getSnapshot()
            let startPaused = false
            let preselectCustom = false
            let initialValue = ''

            if (haltSnapshot.kind === 'paused') {
                startPaused = true
                // Release the global state back to running.
                haltForFeedbackController.resume()
            } else if (haltSnapshot.kind === 'declined') {
                preselectCustom = true
                // This resets global state to running.
                const fb = haltForFeedbackController.takeDeclineAndReset()
                initialValue = (typeof fb === 'string' ? fb : haltSnapshot.feedback)
            }

            // Save to in-memory history immediately to track panel and status
            try {
                askReportHistory.add({
                    id: uid,
                    topic: input.topicName,
                    markdown: input.message,
                    predefinedOptions: Array.isArray(input.predefinedOptions) ? input.predefinedOptions : undefined,
                    result: undefined,
                })
            } catch { }

            // Notify Telegram integration (if active)
            _onAskReportCreated.fire({
                id: uid,
                topicName: input.topicName,
                message: input.message,
                predefinedOptions: Array.isArray(input.predefinedOptions) ? input.predefinedOptions : undefined,
            })

            const result = await askReport({
                title: input.topicName,
                markdown: input.message,
                initialValue,
                predefinedOptions: Array.isArray(input.predefinedOptions)
                    ? input.predefinedOptions
                    : undefined,
                historyId: uid,

                startPaused,
                preselectCustom,
            })

            // Update existing history entry with the final result and persist
            try {
                askReportHistory.updateResult(uid, { decision: result.decision, value: result.value, timeout: result.timeout })
            } catch { }

            let text: string
            if (result.timeout === true) {
                text = 'User did not reply: Timeout occurred.'
            } else if (result.decision === 'Cancel' && (!result.value || result.value.trim() === '')) {
                text = 'User replied with empty input.'
            } else {
                text = `User replied: ${result.value}`
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(text),
            ])
        } finally {
            statusBarActivity.end('ask_report')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<AskReportInput>,
    ): PreparedToolInvocation {
        const topic = options.input?.topicName?.trim()
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)

        md.appendMarkdown(`Relief Pilot · **ask_report**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`)
        md.appendMarkdown(`- Topic: \`${topic ?? '—'}\`  \n`)

        // Generate UID and remember for invoke(); embed in command link
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show report](command:reliefpilot.askReport.showReport?${cmdArgs})`)

        return { invocationMessage: md }
    }
}

// Helper to open/focus a report by id: focus active panel if exists, otherwise open read-only from history
export async function openOrFocusAskReportById(id: string): Promise<void> {
    const entry = askReportHistory.getById(id)
    if (!entry) {
        vscode.window.showErrorMessage('ask_report entry not found in history.')
        return
    }
    if (entry.panel) {
        try { entry.panel.reveal(undefined, false) } catch { /* ignore */ }
        return
    }
    // Open read-only from history and bind panel reference
    void askReport({
        title: entry.topic,
        markdown: entry.markdown,
        predefinedOptions: entry.predefinedOptions,
        readOnly: true,
        historyId: id,
    })
}

// Backward-compatible helper kept for other callers (opens a new read-only panel)
export async function showAskReportReadonly(title: string, markdown: string, predefinedOptions?: string[]) {
    void askReport({ title, markdown, predefinedOptions, readOnly: true })
}

// Utils
function generateNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let text = ''
    for (let i = 0; i < 16; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function serializeForHtmlScriptTag(value: unknown): string {
    // Escape characters that can break out of a <script> tag or change parsing semantics.
    // Keep this minimal and deterministic: JSON + a few safe replacements.
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
}
