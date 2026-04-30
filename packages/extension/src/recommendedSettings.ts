import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import { env } from './utils/env';

export const APPLY_RECOMMENDED_SETTINGS_COMMAND = 'reliefpilot.applyRecommendedSettings';

type RecommendedSettingsMap = Record<string, unknown>;

type RecommendedSettingRow = {
  key: string;
  recommendedText: string;
  currentText: string;
  matches: boolean;
};

let recommendedSettingsPanel: vscode.WebviewPanel | undefined;
let recommendedSettingsRows: RecommendedSettingRow[] = [];

export async function openOrFocusRecommendedSettingsPanel(): Promise<void> {
  if (recommendedSettingsPanel) {
    try { recommendedSettingsPanel.reveal(undefined, false); } catch { /* ignore */ }
    await refreshRecommendedSettingsPanel();
    return;
  }

  const extensionUri = env.extensionUri;
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');

  const panel = vscode.window.createWebviewPanel(
    'reliefpilot.recommendedSettings',
    'Recommended VSCode Settings',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    },
  );

  recommendedSettingsPanel = panel;

  try {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'icon.png');
  } catch {
    // ignore icon assignment errors
  }

  const nonce = generateNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource} data:`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  recommendedSettingsRows = await buildRecommendedSettingsRows();
  panel.webview.html = getRecommendedSettingsHtml({ nonce, csp, rows: recommendedSettingsRows });

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const msg = message as { type?: unknown; key?: unknown };
      if (msg.type === 'apply' && typeof msg.key === 'string') {
        await applyRecommendedSetting(msg.key);
        await refreshRecommendedSettingsPanel();
      } else if (msg.type === 'applyAll') {
        await applyAllRecommendedSettings();
        await refreshRecommendedSettingsPanel();
      } else if (msg.type === 'refresh') {
        await refreshRecommendedSettingsPanel();
      }
    }),
  );

  disposables.push(
    vscode.workspace.onDidChangeConfiguration(() => {
      void refreshRecommendedSettingsPanel();
    }),
  );

  panel.onDidDispose(() => {
    recommendedSettingsPanel = undefined;
    recommendedSettingsRows = [];
    while (disposables.length > 0) {
      const disposable = disposables.pop();
      try { disposable?.dispose(); } catch { /* ignore */ }
    }
  });
}

async function refreshRecommendedSettingsPanel(): Promise<void> {
  const panel = recommendedSettingsPanel;
  if (!panel) {
    return;
  }

  try {
    recommendedSettingsRows = await buildRecommendedSettingsRows();
    await panel.webview.postMessage({ type: 'rows', rows: recommendedSettingsRows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await panel.webview.postMessage({ type: 'error', message });
  }
}

async function applyRecommendedSetting(key: string): Promise<void> {
  const settings = await readRecommendedSettings();
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    vscode.window.showErrorMessage(`Recommended setting not found: ${key}`);
    return;
  }

  try {
    await vscode.workspace
      .getConfiguration()
      .update(key, settings[key], vscode.ConfigurationTarget.Global);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to apply ${key}: ${message}`);
  }
}

async function applyAllRecommendedSettings(): Promise<void> {
  const settings = await readRecommendedSettings();
  const rows = await buildRecommendedSettingsRowsFrom(settings);
  const mismatchedKeys = rows.filter((row) => !row.matches).map((row) => row.key);

  if (mismatchedKeys.length === 0) {
    return;
  }

  const failures: string[] = [];
  for (const key of mismatchedKeys) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await vscode.workspace
        .getConfiguration()
        .update(key, settings[key], vscode.ConfigurationTarget.Global);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${key}: ${message}`);
    }
  }

  if (failures.length > 0) {
    vscode.window.showErrorMessage(`Failed to apply ${failures.length} setting(s). See Relief Pilot recommended settings panel for details.`);
    await recommendedSettingsPanel?.webview.postMessage({ type: 'error', message: failures.join('\n') });
    return;
  }

}

async function buildRecommendedSettingsRows(): Promise<RecommendedSettingRow[]> {
  return buildRecommendedSettingsRowsFrom(await readRecommendedSettings());
}

async function buildRecommendedSettingsRowsFrom(settings: RecommendedSettingsMap): Promise<RecommendedSettingRow[]> {
  return Object.keys(settings).sort((a, b) => a.localeCompare(b)).map((key) => {
    const recommendedValue = settings[key];
    const currentValue = vscode.workspace.getConfiguration().inspect(key)?.globalValue;
    return {
      key,
      recommendedText: formatSettingValue(recommendedValue),
      currentText: formatSettingValue(currentValue),
      matches: deepEqual(currentValue, recommendedValue),
    };
  });
}

async function readRecommendedSettings(): Promise<RecommendedSettingsMap> {
  const settingsUri = vscode.Uri.joinPath(env.extensionUri, 'media', 'settings.json');
  const bytes = await vscode.workspace.fs.readFile(settingsUri);
  const rawText = new TextDecoder('utf-8').decode(bytes);
  const parsed = JSON.parse(stripJsonc(rawText)) as unknown;

  if (!isPlainObject(parsed)) {
    throw new Error('Recommended settings file must contain a JSON object.');
  }

  return parsed;
}

function stripJsonc(input: string): string {
  let withoutComments = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      withoutComments += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') {
        index++;
      }
      withoutComments += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        withoutComments += input[index] === '\n' ? '\n' : ' ';
        index++;
      }
      index++;
      continue;
    }

    withoutComments += char;
  }

  return stripTrailingCommas(withoutComments);
}

function stripTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead] ?? '')) {
        lookahead++;
      }

      if (input[lookahead] === '}' || input[lookahead] === ']') {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function isPlainObject(value: unknown): value is RecommendedSettingsMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatSettingValue(value: unknown): string {
  if (typeof value === 'undefined') {
    return 'Not set';
  }

  const formatted = JSON.stringify(value, null, 2) ?? String(value);
  return expandEscapedLineBreaks(formatted);
}

function expandEscapedLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"');
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }

    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!deepEqual(leftKeys, rightKeys)) {
      return false;
    }

    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return false;
}

function getRecommendedSettingsHtml(opts: { nonce: string; csp: string; rows: RecommendedSettingRow[] }): string {
  const bootstrapPayload = { rows: opts.rows };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${opts.csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Recommended VSCode Settings</title>
    <style>
      body {
        padding: 16px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .settings__container {
        display: grid;
        gap: 14px;
      }
      .settings__header {
        display: grid;
        gap: 6px;
      }
      .settings__title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 650;
      }
      .settings__toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .settings__summary {
        margin-left: auto;
        opacity: 0.82;
      }
      .settings__message {
        display: none;
        white-space: pre-wrap;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 10px;
        background: var(--vscode-editorWidget-background, transparent);
      }
      .settings__table-wrap {
        overflow: auto;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 10px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th, td {
        padding: 10px;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        vertical-align: top;
        text-align: left;
      }
      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--vscode-editor-background);
      }
      tr:last-child td {
        border-bottom: 0;
      }
      code {
        color: var(--vscode-textLink-foreground);
        overflow-wrap: anywhere;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
      }
      .settings__setting-row td {
        background: var(--vscode-editorWidget-background, transparent);
      }
      .settings__setting-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .settings__setting-action {
        flex: 0 0 auto;
        text-align: right;
      }
      .settings__check {
        color: var(--vscode-testing-iconPassed, #2ea043);
        font-size: 1.25rem;
        font-weight: 700;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border-radius: 5px;
        cursor: pointer;
        padding: 6px 12px;
      }
      button:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
      }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button.secondary:hover:not(:disabled) {
        background: var(--vscode-button-secondaryHoverBackground);
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
    </style>
  </head>
  <body>
    <div class="settings__container">
      <header class="settings__header">
        <h1 class="settings__title">Apply recommended settings for VSCode</h1>
      </header>
      <section class="settings__toolbar" aria-label="Actions">
        <button id="applyAllBtn">Apply all</button>
        <button id="refreshBtn" class="secondary">Refresh</button>
        <span id="summary" class="settings__summary"></span>
      </section>
      <section id="message" class="settings__message" aria-live="polite"></section>
      <section class="settings__table-wrap" aria-label="Recommended settings table">
        <table>
          <thead>
            <tr>
              <th>Recommended</th>
              <th>Current User value</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </section>
    </div>
    <script nonce="${opts.nonce}">const BOOTSTRAP = ${serializeForHtmlScriptTag(bootstrapPayload)};</script>
    <script nonce="${opts.nonce}">
      const vscode = acquireVsCodeApi();
      let rows = Array.isArray(BOOTSTRAP.rows) ? BOOTSTRAP.rows : [];

      const rowsEl = document.getElementById('rows');
      const applyAllBtn = document.getElementById('applyAllBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const summaryEl = document.getElementById('summary');
      const messageEl = document.getElementById('message');

      function setMessage(text) {
        if (!messageEl) return;
        if (!text) {
          messageEl.style.display = 'none';
          messageEl.textContent = '';
          return;
        }
        messageEl.style.display = 'block';
        messageEl.textContent = text;
      }

      function setBusy(isBusy) {
        if (applyAllBtn) applyAllBtn.disabled = isBusy;
        if (refreshBtn) refreshBtn.disabled = isBusy;
        const buttons = rowsEl ? rowsEl.querySelectorAll('button[data-key]') : [];
        buttons.forEach((button) => { button.disabled = isBusy; });
      }

      function render() {
        if (!rowsEl || !summaryEl || !applyAllBtn) return;
        rowsEl.textContent = '';
        const mismatchedCount = rows.filter((row) => !row.matches).length;
        summaryEl.textContent = rows.length + ' setting(s), ' + mismatchedCount + ' pending';
        applyAllBtn.disabled = mismatchedCount === 0;

        for (const row of rows) {
          const titleTr = document.createElement('tr');
          titleTr.className = 'settings__setting-row';
          const titleTd = document.createElement('td');
          titleTd.colSpan = 2;
          const titleWrap = document.createElement('div');
          titleWrap.className = 'settings__setting-title';
          const keyCode = document.createElement('code');
          keyCode.textContent = row.key;
          titleWrap.appendChild(keyCode);

          const actionWrap = document.createElement('div');
          actionWrap.className = 'settings__setting-action';
          if (row.matches) {
            const check = document.createElement('span');
            check.className = 'settings__check';
            check.setAttribute('aria-label', 'Applied');
            check.title = 'Applied';
            check.textContent = '✓';
            actionWrap.appendChild(check);
          } else {
            const button = document.createElement('button');
            button.textContent = 'Apply';
            button.dataset.key = row.key;
            button.addEventListener('click', () => {
              setBusy(true);
              setMessage('Applying ' + row.key + '…');
              vscode.postMessage({ type: 'apply', key: row.key });
            });
            actionWrap.appendChild(button);
          }
          titleWrap.appendChild(actionWrap);
          titleTd.appendChild(titleWrap);
          titleTr.appendChild(titleTd);
          rowsEl.appendChild(titleTr);

          const valuesTr = document.createElement('tr');
          const recommendedTd = document.createElement('td');
          const recommendedPre = document.createElement('pre');
          recommendedPre.textContent = row.recommendedText;
          recommendedTd.appendChild(recommendedPre);
          valuesTr.appendChild(recommendedTd);

          const currentTd = document.createElement('td');
          const currentPre = document.createElement('pre');
          currentPre.textContent = row.currentText;
          currentTd.appendChild(currentPre);
          valuesTr.appendChild(currentTd);
          rowsEl.appendChild(valuesTr);
        }
      }

      applyAllBtn?.addEventListener('click', () => {
        setBusy(true);
        setMessage('Applying all pending settings…');
        vscode.postMessage({ type: 'applyAll' });
      });

      refreshBtn?.addEventListener('click', () => {
        setBusy(true);
        setMessage('Refreshing settings…');
        vscode.postMessage({ type: 'refresh' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'rows' && Array.isArray(message.rows)) {
          rows = message.rows;
          setMessage('');
          setBusy(false);
          render();
        } else if (message.type === 'error') {
          setBusy(false);
          setMessage(String(message.message || 'Unknown error'));
        }
      });

      render();
    </script>
  </body>
</html>`;
}

function generateNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function serializeForHtmlScriptTag(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}