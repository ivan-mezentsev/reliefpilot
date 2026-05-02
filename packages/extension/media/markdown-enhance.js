// Shared Markdown enhancement utilities for Relief Pilot webviews.
// This file runs in the WebView context (browser sandbox) — not in the extension host.
// Responsibilities (optionally enabled via flags):
//   - Parse markdown via marked (if available)
//   - (optional) Highlight code blocks via highlight.js
//   - (optional) Render KaTeX math blocks delimited by $$...$$
//   - (optional) Render Mermaid diagrams
//   - (optional) Decorate code blocks with language badge + copy button
// Nothing here sends messages itself; copying uses provided callback.
// All functions are kept side-effect free except render().
//
// API: window.ReliefPilotMarkdownEnhancer.render(container: HTMLElement, markdown: string, copyHandler?: (text: string) => void)
// Behavior: always performs parsing, syntax highlight, Mermaid rendering, and code-badge decoration.
// If copyHandler is not provided, a safe fallback using navigator.clipboard is attempted on user gesture.
(function() {
  const GLOBAL_KEY = 'ReliefPilotMarkdownEnhancer';
  if (window[GLOBAL_KEY]) { return; } // idempotent

  /** Escape basic HTML entities */
  function escapeHtml(s) {
    return (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** Extract probable language from element class lists */
  function extractLanguage(codeEl, preEl) {
    function tryMatch(cls) {
      const m = /(language|lang)-([\w#+.-]+)/i.exec(cls);
      return m ? m[2] : '';
    }
    let lang = '';
    const codeCls = (codeEl.className || '').split(/\s+/);
    for (const c of codeCls) { lang = tryMatch(c); if (lang) break; }
    if (!lang) {
      const preCls = (preEl.className || '').split(/\s+/);
      for (const c of preCls) { lang = tryMatch(c); if (lang) break; }
    }
    return lang;
  }

  /** Use marked lexer to collect fence langs (including empty strings) */
  function collectFenceLangs(md) {
    try {
      if (!window.marked || typeof window.marked.lexer !== 'function') return null;
      const tokens = window.marked.lexer(String(md || ''));
      const langs = [];
      for (const t of tokens) {
        if (t && typeof t === 'object' && t.type === 'code') {
          langs.push(String(t.lang || '').trim());
        }
      }
      return langs;
    } catch { return null; }
  }

  /** Render TeX to HTML via KaTeX */
  function renderKatex(tex, displayMode) {
    try {
      if (!window.katex || typeof window.katex.renderToString !== 'function') return escapeHtml(tex || '');
      return window.katex.renderToString(tex || '', {
        displayMode: displayMode === true,
        throwOnError: false,
        trust: false,
      });
    } catch {
      return escapeHtml(tex || '');
    }
  }

  /** Configure marked once with KaTeX math support */
  function configureMarked() {
    if (!window.marked) return;
    try {
      if (typeof window.marked.setOptions === 'function') {
        window.marked.setOptions({ gfm: true });
      } else if (typeof window.marked.use === 'function') {
        window.marked.use({ gfm: true });
      }
    } catch { /* ignore */ }

    try {
      if (!window.__reliefPilotMarkedMathConfigured && window.katex && typeof window.marked.use === 'function') {
        window.marked.use({
          extensions: [
            {
              name: 'mathBlock',
              level: 'block',
              start(src) { return src.match(/\$\$/)?.index; },
              tokenizer(src) {
                const match = /^\s*\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n|$)/.exec(src);
                if (!match || !match[1].trim()) return;
                return {
                  type: 'mathBlock',
                  raw: match[0],
                  text: match[1].trim(),
                };
              },
              renderer(token) {
                return '<div class="math math-display">' + renderKatex(token.text, true) + '</div>\n';
              },
            },
            {
              name: 'mathInline',
              level: 'inline',
              start(src) { return src.match(/\$/)?.index; },
              tokenizer(src) {
                if (src.startsWith('$$')) return;
                const match = /^\$((?:\\.|[^$\\\n])+?)\$/.exec(src);
                if (!match || !match[1].trim()) return;
                return {
                  type: 'mathInline',
                  raw: match[0],
                  text: match[1].trim(),
                };
              },
              renderer(token) {
                return '<span class="math math-inline">' + renderKatex(token.text, false) + '</span>';
              },
            },
          ],
        });
        window.__reliefPilotMarkedMathConfigured = true;
      }
    } catch { /* ignore */ }

    try {
      window.marked.use({ mangle: false, headerIds: false });
    } catch { /* ignore */ }
  }

  /** SVG markup for copy icon */
  function getCopySvg() {
    return '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n' +
      '<path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z" fill="currentColor"/>\n' +
      '<path d="M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z" fill="currentColor"/>\n' +
      '</svg>';
  }

  /** Decorate code blocks with language + copy badge */
  function decorateCodeBlocks(container, langs, copyHandler) {
    let ptr = 0;
    function nextLang() {
      if (!Array.isArray(langs)) return undefined;
      while (ptr < langs.length) {
        const l = (langs[ptr++] || '').trim();
        if (l.toLowerCase() === 'mermaid') continue; // skip mermaid blocks (converted earlier)
        return l; // may be empty
      }
      return undefined;
    }
    const pres = container.querySelectorAll('pre');
    pres.forEach((pre) => {
      if (pre.querySelector('.code-badge')) return; // already decorated
      const code = pre.querySelector('code');
      if (!code) return;
      if (code.classList.contains('language-mermaid')) return; // mermaid already transformed
      // Badge label must reflect only explicitly specified fence language from source.
      // Do NOT use highlight.js autodetection for label to avoid misleading tags.
      const mapped = nextLang();
      let lang = (typeof mapped === 'string') ? mapped : '';
      // Copy handler fallback to Web Clipboard API if not provided
      const onCopy = (typeof copyHandler === 'function')
        ? copyHandler
        : (text) => { try { navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.writeText(text); } catch { /* ignore */ } };
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'code-badge';
      badge.setAttribute('aria-label', 'Copy code');
  const langUpper = lang ? String(lang).toUpperCase() : '';
      badge.title = lang ? (langUpper + ' — Click to copy') : 'Copy';
      if (lang) {
        badge.innerHTML = '<span class="code-badge__lang">' + escapeHtml(langUpper) + '</span>' + getCopySvg();
      } else {
        badge.innerHTML = getCopySvg();
      }
      badge.addEventListener('click', () => {
        const text = code.textContent || '';
        try { onCopy(text); } catch { /* ignore */ }
        badge.classList.add('active');
        setTimeout(() => badge.classList.remove('active'), 250);
      });
      pre.style.position = pre.style.position || 'relative';
      pre.appendChild(badge);
    });
  }

  /** Highlight fenced code blocks (non-mermaid) */
  function highlightCodeBlocks(container) {
    if (!window.hljs) return;
    container.querySelectorAll('pre code:not(.language-mermaid)').forEach((block) => {
      try { window.hljs.highlightElement(block); } catch { /* ignore */ }
    });
  }

  /** Render mermaid diagrams safely */
  function renderMermaid(container) {
    if (!window.mermaid) return;
    try {
      if (!window.mermaidInitialized) {
        const bodyStyle = getComputedStyle(document.body);
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            background: bodyStyle.getPropertyValue('--vscode-editor-background').trim(),
            primaryColor: bodyStyle.getPropertyValue('--vscode-editorWidget-background').trim(),
            primaryTextColor: bodyStyle.getPropertyValue('--vscode-editor-foreground').trim(),
            lineColor: bodyStyle.getPropertyValue('--vscode-editorWidget-border').trim(),
            nodeBorder: bodyStyle.getPropertyValue('--vscode-focusBorder').trim(),
          },
        });
        window.mermaidInitialized = true;
      }
      // Convert mermaid fenced code blocks into containers
      container.querySelectorAll('pre code.language-mermaid').forEach((block) => {
        const parent = block.parentElement;
        if (!parent) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid';
        wrapper.textContent = block.textContent || '';
        parent.replaceWith(wrapper);
      });
      window.mermaid.run();
    } catch (e) {
      console.warn('Mermaid render failed:', e);
    }
  }

  /** Main render function */
  function render(container, markdown, copyHandler) {
    if (!container) return;
    let html = '';
    try {
      if (window.marked) {
        configureMarked();
        html = window.marked.parse(markdown || '', { async: false });
      } else {
        html = escapeHtml(markdown || '');
      }
    } catch { html = escapeHtml(markdown || ''); }
    container.innerHTML = html;

    // Always enhance
    highlightCodeBlocks(container);
    renderMermaid(container);
    try {
      const langs = collectFenceLangs(markdown || '');
      decorateCodeBlocks(container, langs, copyHandler);
    } catch { /* ignore */ }
  }

  // Expose API
  window[GLOBAL_KEY] = { render };
})();
