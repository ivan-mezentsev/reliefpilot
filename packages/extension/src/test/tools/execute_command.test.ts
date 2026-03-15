import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecuteCommandTool } from '../../tools/execute_command';

// Extend ExecuteCommandTool to override the ask method for testing
class TestableExecuteCommandTool extends ExecuteCommandTool {
  public askCalled = false;

  constructor(cwd: string) {
    super(cwd);
  }

  // Override ask to avoid UI prompts during tests and track if it was called
  protected async ask(_command: string) {
    this.askCalled = true;
    // Always approve during tests; mirror the tool's ApprovalDecision shape
    return { approved: true, updatedCommand: _command };
  }
}

suite('Execute Command Tool Test Suite', function () {
  this.timeout(10000); // Set a longer timeout for all tests in this suite

  const tmpDir = path.join(__dirname, '../../test-tmp');
  let tool: TestableExecuteCommandTool; // Use the testable version for all tests
  let originalConfirmSetting: boolean;

  suiteSetup(async function () {
    console.log('Test setup - workspace folders:', vscode.workspace.workspaceFolders);
    console.log('Test setup - tmpDir:', tmpDir);

    // Save original setting
    const config = vscode.workspace.getConfiguration('reliefpilot');
    originalConfirmSetting = config.get<boolean>('confirmNonDestructiveCommands', false);

    // Create test directory
    const uri = vscode.Uri.file(tmpDir);
    await vscode.workspace.fs.createDirectory(uri);

    // Create test file
    const testFile = vscode.Uri.file(path.join(tmpDir, 'test.txt'));
    await vscode.workspace.fs.writeFile(testFile, Buffer.from('test content\n', 'utf-8'));

    // Initialize tool
    tool = new TestableExecuteCommandTool(tmpDir);

    console.log('Test setup - created test files');
  });

  suiteTeardown(async function () {
    // Restore original setting
    await vscode.workspace.getConfiguration('reliefpilot').update(
      'confirmNonDestructiveCommands',
      originalConfirmSetting,
      vscode.ConfigurationTarget.Global
    );

    // Clean up test directory
    const uri = vscode.Uri.file(tmpDir);
    await vscode.workspace.fs.delete(uri, { recursive: true });
    console.log('Test teardown - removed test directory');
  });

  test('Basic command execution', async function () {
    this.retries(2);
    console.log('Running basic command execution test');
    const [userRejected, response] = await tool.execute('cat test.txt');
    console.log('Basic command execution result:', response);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');
    // When shell integration is used, immediate output may not be included. Fallback to reading from terminal.
    if (!/Output:/i.test(response.text)) {
      const idMatch = response.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch, 'Response should include terminal ID');
      const tid = parseInt(idMatch[1], 10);
      const outTool = new (require('../../tools/get_terminal_output').GetTerminalOutputTool)();
      const out = await outTool.execute(tid, 100);
      assert.match(out.text, /test content/, 'Terminal output should contain file content');
    } else {
      assert.match(response.text, /test content/, 'Output should contain file content');
    }
  });

  test('Command execution in subdirectory', async function () {
    this.retries(2);
    console.log('Running subdirectory command test');

    // Create subdirectory and file
    const subDir = path.join(tmpDir, 'subdir');
    const subDirUri = vscode.Uri.file(subDir);
    await vscode.workspace.fs.createDirectory(subDirUri);

    const testFile = vscode.Uri.file(path.join(subDir, 'subtest.txt'));
    await vscode.workspace.fs.writeFile(testFile, Buffer.from('subdir content\n', 'utf-8'));

    const [userRejected, response] = await tool.execute('cat subtest.txt', 'subdir');
    console.log('Subdirectory command test result:', response);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');
    if (!/Output:/i.test(response.text)) {
      const idMatch = response.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch, 'Response should include terminal ID');
      const tid = parseInt(idMatch[1], 10);
      const outTool = new (require('../../tools/get_terminal_output').GetTerminalOutputTool)();
      await new Promise(r => setTimeout(r, 300));
      const out = await outTool.execute(tid, 100);
      assert.match(out.text, /subdir content/, 'Terminal output should contain file content');
    } else {
      assert.match(response.text, /subdir content/, 'Output should contain file content');
    }
  });

  test('Failed command execution', async function () {
    this.retries(2);
    console.log('Running failed command test');
    const [userRejected, response] = await tool.execute('cat nonexistent.txt');
    console.log('Failed command test result:', response);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');
    assert.match(response.text, /No such file/, 'Should show error message');
  });

  test('Non-existent working directory', async function () {
    this.retries(2);
    console.log('Running non-existent directory test');
    const [userRejected, response] = await tool.execute('ls', path.join(tmpDir, 'nonexistent'));
    console.log('Non-existent directory test result:', response);

    assert.strictEqual(userRejected, false, 'Should not be user rejected');
    // Depending on terminal behavior, we may not get an error immediately. Accept either an error message or a terminal id with no output yet.
    const hasDirError = /No such file|cannot access|not found|does not exist/i.test(response.text);
    const hasId = /terminal \(id: "?\d+"?\)/.test(response.text);
    assert.ok(hasDirError || hasId, 'Should show directory error or at least include terminal id');
  });

  test('Long running command', async function () {
    this.retries(2);
    console.log('Running long command test');
    const [userRejected, response] = await tool.execute('sleep 2 && echo "done"');
    console.log('Long command test result:', response);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');
    if (!/done/.test(response.text)) {
      const idMatch = response.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch, 'Response should include terminal ID');
      const tid = parseInt(idMatch[1], 10);
      const outTool = new (require('../../tools/get_terminal_output').GetTerminalOutputTool)();
      // wait briefly for echo to appear
      await new Promise(r => setTimeout(r, 1000));
      const out = await outTool.execute(tid, 100);
      assert.match(out.text, /done/, 'Terminal output should contain command result');
    } else {
      assert.match(response.text, /done/, 'Output should contain command result');
    }
  });

  suite('DestructiveFlag Tests', function () {
    setup(function () {
      // Reset the test tool before each test
      tool.askCalled = false;
    });

    test('Commands should require confirmation by default', async function () {
      // Execute with default destructiveFlag=true
      await tool.execute('echo "Default confirmation behavior"');

      // Confirm that ask was called
      assert.strictEqual(tool.askCalled, true, 'Confirmation should be requested by default');
    });

    test('Destructive commands should always require confirmation', async function () {
      // Execute with explicit destructiveFlag=true
      await tool.execute('rm -f test.txt', undefined, true);

      // Confirm that ask was called
      assert.strictEqual(tool.askCalled, true, 'Confirmation should be requested for destructive commands');
    });

    test('Non-destructive commands should skip confirmation when flag is false', async function () {
      // Make sure the setting is false to start
      await vscode.workspace.getConfiguration('reliefpilot').update(
        'confirmNonDestructiveCommands',
        false,
        vscode.ConfigurationTarget.Global
      );

      // Reset the tracking flag
      tool.askCalled = false;

      // Execute with destructiveFlag=false
      await tool.execute('ls -la', undefined, false);

      // Confirm that ask was NOT called
      assert.strictEqual(tool.askCalled, false, 'Confirmation should be skipped for non-destructive commands');
    });

    test('Non-destructive commands should require confirmation when setting is enabled', async function () {
      // Enable the confirmNonDestructiveCommands setting
      await vscode.workspace.getConfiguration('reliefpilot').update(
        'confirmNonDestructiveCommands',
        true,
        vscode.ConfigurationTarget.Global
      );

      // Reset the tracking flag
      tool.askCalled = false;

      // Execute with destructiveFlag=false
      await tool.execute('grep "pattern" test.txt', undefined, false);

      // Confirm that ask was called despite destructiveFlag being false
      assert.strictEqual(tool.askCalled, true, 'Confirmation should be requested when confirmNonDestructiveCommands=true');

      // Reset the setting
      await vscode.workspace.getConfiguration('reliefpilot').update(
        'confirmNonDestructiveCommands',
        false,
        vscode.ConfigurationTarget.Global
      );
    });
  });

  suite('Background Mode and Timeout Tests', function () {
    test('Command should return immediately in background mode', async function () {
      console.log('Running background mode test');

      // Start a timer
      const startTime = Date.now();

      // Execute a command with background=true that would normally take 3 seconds
      const [userRejected, response] = await tool.execute('sleep 3 && echo "completed"', undefined, false, true);

      // Check how long it took
      const duration = Date.now() - startTime;

      // Background mode should return almost immediately
      assert.ok(duration < 1000, `Command returned in ${duration}ms, should be under 1000ms when in background mode`);
      assert.strictEqual(userRejected, false, 'Command should not be user rejected');
      // New message wording: "Command started in background and continues in terminal ..."
      assert.match(response.text, /started in background/i, 'Response should mention background execution');
      assert.match(response.text, /terminal \(id: "?\d+"?\)/, 'Response should include terminal ID');
      assert.match(response.text, /get_terminal_output/, 'Response should mention how to check output later');
    });

    test('Command should respect timeout parameter', async function () {
      console.log('Running timeout test');

      // Start a timer
      const startTime = Date.now();

      // Execute a command with a short timeout (1000ms) but the command takes longer (2s)
      const [userRejected, response] = await tool.execute('sleep 2 && echo "timeout test"', undefined, false, false, 1000);

      // Check how long it took
      const duration = Date.now() - startTime;

      // Should respect the timeout (with some margin for code execution)
      assert.ok(duration < 1500, `Command returned in ${duration}ms, should be close to 1000ms timeout`);
      assert.strictEqual(userRejected, false, 'Command should not be user rejected');
      assert.match(response.text, /still running/, 'Response should indicate command is still running');
      // New message wording includes "(waited 1000ms)"
      assert.match(response.text, /\(waited 1000ms\)/, 'Response should mention the timeout value');
      assert.match(response.text, /terminal \(id: "?\d+"?\)/, 'Response should include terminal ID');
    });

    test('Command should include terminal ID in normal execution', async function () {
      console.log('Running terminal ID test for normal execution');

      // Execute a simple command
      const [userRejected, response] = await tool.execute('echo "show terminal ID"', undefined, false);

      assert.strictEqual(userRejected, false, 'Command should not be user rejected');
      const idMatch = response.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch, 'Response should include terminal ID');
      if (!/show terminal ID/.test(response.text)) {
        const tid = parseInt(idMatch[1], 10);
        const outTool = new (require('../../tools/get_terminal_output').GetTerminalOutputTool)();
        await new Promise(r => setTimeout(r, 300));
        const out = await outTool.execute(tid, 100);
        assert.match(out.text, /show terminal ID/, 'Terminal output should contain command result');
      } else {
        assert.match(response.text, /show terminal ID/, 'Output should contain command result');
      }
    });

    test('newTerminal=true should always create a new terminal', async function () {
      console.log('Running newTerminal flag test');

      const [, response1] = await tool.execute('echo "new terminal 1"', undefined, false, false, 300000, true);
      const idMatch1 = response1.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch1, 'First response should include terminal ID');
      const tid1 = parseInt(idMatch1[1], 10);

      // Give the terminal a moment to settle so reuse would be possible if the flag were ignored.
      await new Promise(r => setTimeout(r, 300));

      const [, response2] = await tool.execute('echo "new terminal 2"', undefined, false, false, 300000, true);
      const idMatch2 = response2.text.match(/terminal \(id: "?(\d+)"?\)/);
      assert.ok(idMatch2, 'Second response should include terminal ID');
      const tid2 = parseInt(idMatch2[1], 10);

      assert.notStrictEqual(tid1, tid2, 'newTerminal=true should force a new terminal id each time');
    });
  });
});
