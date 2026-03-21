const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '../..');
const extensionTestsPath = path.resolve(__dirname, 'extension-test-runner.cjs');
const eventsFile = path.resolve(extensionRoot, '.vscode-test', 'reliefpilot-test-events.jsonl');

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  prepareEventsFile(eventsFile);

  const printer = createEventPrinter(eventsFile);
  const restoreStdout = interceptWrite(process.stdout, shouldFilterNoise);
  const restoreStderr = interceptWrite(process.stderr, shouldFilterNoise);

  let failure;

  try {
    await runTests({
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath,
      extensionTestsEnv: {
        RELIEFPILOT_TEST_EVENTS_FILE: eventsFile,
      },
      launchArgs: [repoRoot, '--disable-logging'],
      version: 'insiders',
    });
  } catch (error) {
    failure = error;
  } finally {
    restoreStdout();
    restoreStderr();
    await printer.stop();
  }

  if (!failure) {
    return;
  }

  if (!printer.state.sawSummary) {
    console.error('\nFAIL Test run terminated before the reporter produced a final summary.');
  }

  if (!printer.state.sawFailureDetails) {
    console.error(failure && failure.stack ? failure.stack : String(failure));
  }

  process.exit(1);
}

function prepareEventsFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
}

function createEventPrinter(filePath) {
  const state = {
    completed: 0,
    started: 0,
    sawFailureDetails: false,
    sawSummary: false,
    total: 0,
  };

  let consumedChars = 0;
  let remainder = '';
  const timer = setInterval(flush, 50);

  return {
    state,
    stop: async () => {
      clearInterval(timer);
      flush(true);
    },
  };

  function flush(includeRemainder = false) {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    if (content.length < consumedChars) {
      consumedChars = 0;
      remainder = '';
    }

    const chunk = content.slice(consumedChars);

    if (!chunk && !includeRemainder) {
      return;
    }

    consumedChars = content.length;
    remainder += chunk;

    const lines = remainder.split(/\r?\n/);
    remainder = includeRemainder ? '' : lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      handleEvent(JSON.parse(line));
    }

    if (includeRemainder && remainder.trim()) {
      handleEvent(JSON.parse(remainder));
      remainder = '';
    }
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'start': {
        state.total = event.total;
        console.log(`\n${label('summary')} Running ${event.total} ${pluralize(event.total, 'test')}\n`);
        break;
      }
      case 'test-start': {
        state.started += 1;
        console.log(`${formatProgress(state.started, state.total)} ${label('run')} ${event.title}`);
        break;
      }
      case 'pass': {
        state.completed += 1;
        console.log(`${formatProgress(state.completed, state.total)} ${label('pass')} ${event.title} ${formatDuration(event.duration)}`);
        break;
      }
      case 'pending': {
        state.completed += 1;
        console.log(`${formatProgress(state.completed, state.total)} ${label('skip')} ${event.title}`);
        break;
      }
      case 'fail': {
        state.completed += 1;
        state.sawFailureDetails = true;
        console.log(`${formatProgress(state.completed, state.total)} ${event.timeout ? label('timeout') : label('fail')} ${event.title} ${formatDuration(event.duration)}`);

        const details = String(event.stack || event.message || '')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => `      ${line}`)
          .join('\n');

        if (details) {
          console.log(details);
        }
        break;
      }
      case 'end': {
        state.sawSummary = true;
        const parts = [`${event.passes} passed`, `${event.failures} failed`];

        if (event.pending > 0) {
          parts.push(`${event.pending} skipped`);
        }

        console.log(`\n${label('summary')} ${parts.join(', ')} in ${formatDurationValue(event.duration)}\n`);
        break;
      }
      default:
        break;
    }
  }
}

function interceptWrite(stream, predicate) {
  const originalWrite = stream.write.bind(stream);
  let buffer = '';

  stream.write = (chunk, encoding, callback) => {
    const normalizedChunk = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : undefined) : String(chunk);
    buffer += normalizedChunk;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!predicate(line)) {
        originalWrite(`${line}\n`);
      }
    }

    if (typeof callback === 'function') {
      callback();
    }

    return true;
  };

  return () => {
    if (buffer && !predicate(buffer)) {
      originalWrite(buffer);
    }

    stream.write = originalWrite;
  };
}

function shouldFilterNoise(line) {
  return /^Warning: 'disable-logging' is not in the list of known options, but still passed to Electron\/Chromium\.$/.test(line)
    || /^\[[^\]]+trust_store_mac\.cc:\d+\] Error parsing certificate:$/.test(line)
    || /^ERROR: Failed normalizing string$/.test(line)
    || /^  tag: \d+$/.test(line)
    || /^ERROR: Failed normalizing subject$/.test(line);
}

function formatProgress(current, total) {
  const safeTotal = Math.max(total || current || 0, current);
  const width = String(safeTotal).length;
  return `[${String(current).padStart(width, ' ')}/${safeTotal}]`;
}

function formatDuration(durationMs) {
  return `(${formatDurationValue(durationMs)})`;
}

function formatDurationValue(durationMs) {
  const value = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  return `${Math.round(value)}ms`;
}

function pluralize(count, word) {
  return count === 1 ? word : `${word}s`;
}

function label(type) {
  switch (type) {
    case 'run':
      return colorize('36', 'RUN ');
    case 'pass':
      return colorize('32', 'PASS');
    case 'fail':
      return colorize('31', 'FAIL');
    case 'timeout':
      return colorize('31', 'FAIL (timeout)');
    case 'skip':
      return colorize('33', 'SKIP');
    default:
      return colorize('36', 'SUMMARY');
  }
}

function colorize(code, text) {
  if (!process.stdout.isTTY) {
    return text;
  }

  return `\u001b[${code}m${text}\u001b[0m`;
}