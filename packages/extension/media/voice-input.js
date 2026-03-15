// Shared voice input logic for webview panels.
// Usage: initVoiceInput({ micBtn, textarea, vscode })
// eslint-disable-next-line no-unused-vars
function initVoiceInput(opts) {
  var micBtn = opts.micBtn;
  var textarea = opts.textarea;
  var vscode = opts.vscode;
  if (!micBtn || !textarea) return;

  // Inject recording-state styles
  var s = document.createElement('style');
  s.textContent =
    '.mic-recording{color:#e74c3c!important;opacity:1!important;animation:mic-pulse 1s ease-in-out infinite}' +
    '.mic-processing{color:#f39c12!important;opacity:1!important;animation:mic-pulse 0.5s ease-in-out infinite}' +
    '@keyframes mic-pulse{0%,100%{opacity:1}50%{opacity:0.35}}';
  document.head.appendChild(s);

  var isRecording = false;

  micBtn.addEventListener('click', function () {
    if (isRecording) {
      vscode.postMessage({ type: 'stopRecording' });
      isRecording = false;
      micBtn.classList.remove('mic-recording');
      micBtn.classList.add('mic-processing');
      micBtn.setAttribute('aria-label', 'Transcribing...');
    } else {
      vscode.postMessage({ type: 'startRecording' });
      isRecording = true;
      micBtn.classList.add('mic-recording');
      micBtn.setAttribute('aria-label', 'Stop recording');
    }
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'speechResult' && typeof msg.text === 'string' && msg.text) {
      var cur = textarea.value;
      textarea.value = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + msg.text;
      textarea.dispatchEvent(new Event('input'));
    } else if (msg.type === 'speechEnded') {
      micBtn.classList.remove('mic-processing', 'mic-recording');
      micBtn.setAttribute('aria-label', 'Voice input');
      isRecording = false;
    } else if (msg.type === 'speechError') {
      micBtn.classList.remove('mic-processing', 'mic-recording');
      micBtn.setAttribute('aria-label', 'Voice input');
      isRecording = false;
    } else if (msg.type === 'toggleRecording') {
      micBtn.click();
    }
  });
}
