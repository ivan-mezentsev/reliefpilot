// Webview panel to display the static markdown content produced by Google tools.
import * as vscode from 'vscode'
import { env } from './env'
import { getGoogleContentSession } from './google_search_content_sessions'

export async function openGoogleContentPanelByUid(uid: string): Promise<void> {
    let session = getGoogleContentSession(uid)
    if (!session) {
        const deadline = Date.now() + 30000
        while (!session && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150))
            session = getGoogleContentSession(uid)
        }
        if (!session) {
            return
        }
    }

    if (session.panel) {
        session.panel.reveal(undefined, false)
        return
    }

    const panel = vscode.window.createWebviewPanel(
        'reliefpilot.googleContent',
        'Relief Pilot: Google Content',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(env.extensionUri, 'media')],
        },
    )
    session.panel = panel

    try {
        panel.iconPath = vscode.Uri.joinPath(env.extensionUri, 'icon_mono.png')
    } catch { }

    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(env.extensionUri, 'media', 'highlight.github.css'))
    const enhanceCssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(env.extensionUri, 'media', 'markdown-enhance.css'))
    const markdownDepsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(env.extensionUri, 'media', 'markdown-deps.js'))
    const markdownEnhanceUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(env.extensionUri, 'media', 'markdown-enhance.js'))

    const nonce = Math.random().toString(36).slice(2)
    const csp = [
        "default-src 'none'",
        `img-src ${panel.webview.cspSource} blob: data:`,
        `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ')

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <link rel="stylesheet" href="${enhanceCssUri}" />
    <title>Relief Pilot: Google Content</title>
    <style>
      html, body { height: 100%; }
      body { margin: 0; font-family: var(--vscode-font-family, system-ui, Arial, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
      .layout { display: flex; flex-direction: column; height: 100vh; }
      .col { overflow: auto; padding: 12px; }
      .section-title { font-size: 12px; opacity: 0.8; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .08em; }
      .markdown { line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="col">
        <p class="section-title">Google Tool Output (Markdown)</p>
        <section class="markdown" id="contentMd">${session.contentBuffer ? '' : '<em class="muted">Loading…</em>'}</section>
      </div>
    </div>
    <script nonce="${nonce}" src="${markdownDepsUri}"></script>
    <script nonce="${nonce}" src="${markdownEnhanceUri}"></script>
    <script nonce="${nonce}">
      const elContent = document.getElementById('contentMd');
      window.addEventListener('message', (e) => {
        const msg = e.data || {};
        if (msg.type === 'content') {
          try {
            if (window.ReliefPilotMarkdownEnhancer) {
              window.ReliefPilotMarkdownEnhancer.render(elContent, msg.markdown || '', (text) => {
                try { navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.writeText(text); } catch {}
              });
            } else if (window.marked) {
              elContent.innerHTML = window.marked.parse(msg.markdown || '');
            } else {
              elContent.textContent = msg.markdown || '';
            }
          } catch {
            elContent.textContent = msg.markdown || '';
          }
        }
      });
    </script>
  </body>
</html>`

    const sub = session.contentEmitter.event((md: string) => panel.webview.postMessage({ type: 'content', markdown: md }))
    panel.onDidDispose(() => {
        sub.dispose()
        if (session) {
            session.panel = undefined
        }
    })

    if (session.contentBuffer) {
        panel.webview.postMessage({ type: 'content', markdown: session.contentBuffer })
    }
}
