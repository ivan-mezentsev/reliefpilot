(function () {
  var GLOBAL_KEY = 'ReliefPilotVoiceInput';
  if (window[GLOBAL_KEY]) {
    return;
  }

  var STATES = {
    idle: 'idle',
    recording: 'recording',
    processing: 'processing',
  };

  function appendTranscription(textarea, text) {
    var current = textarea.value || '';
    textarea.value = current + (current && !current.endsWith(' ') ? ' ' : '') + text;
    textarea.dispatchEvent(new Event('input'));
  }

  function createController(opts) {
    var micBtn = opts.micBtn;
    var textarea = opts.textarea;
    var vscode = opts.vscode;
    if (!micBtn || !textarea || !vscode) {
      return;
    }

    if (micBtn.dataset.reliefPilotVoiceInputBound === 'true') {
      return;
    }
    micBtn.dataset.reliefPilotVoiceInputBound = 'true';

    var state = STATES.idle;

    function renderState() {
      micBtn.classList.remove('voice-input__button--recording', 'voice-input__button--processing');
      micBtn.removeAttribute('disabled');

      if (state === STATES.recording) {
        micBtn.classList.add('voice-input__button--recording');
        micBtn.setAttribute('aria-label', 'Stop recording');
        micBtn.setAttribute('title', 'Stop recording');
        return;
      }

      if (state === STATES.processing) {
        micBtn.classList.add('voice-input__button--processing');
        micBtn.setAttribute('aria-label', 'Transcribing...');
        micBtn.setAttribute('title', 'Transcribing...');
        return;
      }

      micBtn.setAttribute('aria-label', 'Voice input');
      micBtn.setAttribute('title', 'Voice input');
    }

    function startRecording() {
      if (state !== STATES.idle) {
        return;
      }

      state = STATES.recording;
      renderState();
      vscode.postMessage({ type: 'startRecording' });
    }

    function stopRecording() {
      if (state !== STATES.recording) {
        return;
      }

      state = STATES.processing;
      renderState();
      vscode.postMessage({ type: 'stopRecording' });
    }

    function toggleRecording() {
      if (state === STATES.idle) {
        startRecording();
        return;
      }

      if (state === STATES.recording) {
        stopRecording();
      }
    }

    function reset() {
      state = STATES.idle;
      renderState();
    }

    micBtn.addEventListener('click', function () {
      toggleRecording();
    });

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'speechResult' && typeof msg.text === 'string' && msg.text) {
        appendTranscription(textarea, msg.text);
        return;
      }

      if (msg.type === 'speechEnded' || msg.type === 'speechError') {
        reset();
        return;
      }

      if (msg.type === 'toggleRecording') {
        toggleRecording();
      }
    });

    renderState();
  }

  window[GLOBAL_KEY] = {
    init: createController,
  };
})();
