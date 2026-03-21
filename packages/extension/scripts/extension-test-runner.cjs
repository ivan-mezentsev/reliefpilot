const fs = require('node:fs');
const path = require('node:path');
const Mocha = require('mocha');

module.exports = { run };

async function run() {
  const eventsFile = process.env.RELIEFPILOT_TEST_EVENTS_FILE;

  if (!eventsFile) {
    throw new Error('RELIEFPILOT_TEST_EVENTS_FILE is required.');
  }

  const testsRoot = path.resolve(__dirname, '..', 'out', 'test');
  const reporter = createJsonLineReporter(eventsFile);
  const mocha = new Mocha({
    color: true,
    reporter,
    ui: 'tdd',
  });

  for (const file of collectTestFiles(testsRoot)) {
    mocha.addFile(file);
  }

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(failures === 1 ? '1 test failed.' : `${failures} tests failed.`));
        return;
      }

      resolve();
    });
  });
}

function collectTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(absolutePath);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function createJsonLineReporter(eventsFile) {
  return class JsonLineReporter {
    constructor(runner) {
      const stats = {
        passes: 0,
        failures: 0,
        pending: 0,
      };

      runner.once('start', () => {
        writeEvent(eventsFile, { type: 'start', total: runner.total });
      });

      runner.on('test', (test) => {
        writeEvent(eventsFile, {
          type: 'test-start',
          title: test.fullTitle(),
        });
      });

      runner.on('pass', (test) => {
        stats.passes += 1;
        writeEvent(eventsFile, {
          type: 'pass',
          title: test.fullTitle(),
          duration: test.duration,
        });
      });

      runner.on('pending', (test) => {
        stats.pending += 1;
        writeEvent(eventsFile, {
          type: 'pending',
          title: test.fullTitle(),
        });
      });

      runner.on('fail', (test, err) => {
        stats.failures += 1;
        writeEvent(eventsFile, {
          type: 'fail',
          title: test.fullTitle(),
          duration: typeof test.duration === 'number' ? test.duration : 0,
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : null,
          timeout: isTimeoutError(err),
        });
      });

      runner.once('end', () => {
        writeEvent(eventsFile, {
          type: 'end',
          duration: runner.stats && typeof runner.stats.duration === 'number' ? runner.stats.duration : 0,
          failures: stats.failures,
          passes: stats.passes,
          pending: stats.pending,
        });
      });
    }
  };
}

function writeEvent(eventsFile, event) {
  fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
}

function isTimeoutError(err) {
  if (!err) {
    return false;
  }

  return err.code === 'ERR_MOCHA_TIMEOUT' || /timeout/i.test(String(err.message || ''));
}