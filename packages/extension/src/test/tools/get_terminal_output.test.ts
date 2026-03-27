import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalRegistry } from '../../integrations/terminal/TerminalRegistry';
import { ExecuteCommandTool } from '../../tools/execute_command';
import { GetTerminalOutputTool } from '../../tools/get_terminal_output';

// Testing version of ExecuteCommandTool
class TestableExecuteCommandTool extends ExecuteCommandTool {
  constructor(cwd: string) {
    super(cwd);
  }

  // Override ask to avoid UI prompts during tests
  protected async ask(_command: string) {
    // Always approve during tests; mirror the tool's ApprovalDecision shape
    return { approved: true, updatedCommand: _command };
  }
}

async function waitForTerminalOutput(
  getOutputTool: GetTerminalOutputTool,
  terminalId: number,
  pattern: RegExp,
  maxLines: number = 1000,
  attempts = 12,
  delayMs = 250,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await getOutputTool.execute(terminalId, maxLines);
    if (pattern.test(response.text)) {
      return response.text;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const finalResponse = await getOutputTool.execute(terminalId, maxLines);
  return finalResponse.text;
}

suite('Get Terminal Output Tool Test Suite', function () {
  this.timeout(15000); // Extended timeout for terminal operations

  const tmpDir = path.join(__dirname, '../../test-tmp');
  let execTool: TestableExecuteCommandTool;
  let getOutputTool: GetTerminalOutputTool;
  let testTerminalId: number;

  suiteSetup(async function () {
    console.log('Test setup - workspace folders:', vscode.workspace.workspaceFolders);
    console.log('Test setup - tmpDir:', tmpDir);

    // Create test directory
    const uri = vscode.Uri.file(tmpDir);
    await vscode.workspace.fs.createDirectory(uri);

    // Initialize tools
    execTool = new TestableExecuteCommandTool(tmpDir);
    getOutputTool = new GetTerminalOutputTool();

    console.log('Test setup - created test files');
  });

  suiteTeardown(async function () {
    // Clean up test directory
    const uri = vscode.Uri.file(tmpDir);
    await vscode.workspace.fs.delete(uri, { recursive: true });
    console.log('Test teardown - removed test directory');
  });

  test('Setup terminal for subsequent tests', async function () {
    // Run a command to create a terminal and capture its ID
    const [userRejected, response] = await execTool.execute('echo "Terminal setup for testing"', undefined, false);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');

    // Extract terminal ID from the response
    const match = response.text.match(/terminal \(id: "?(\d+)"?\)/);
    assert.ok(match, 'Response should contain terminal ID');
    testTerminalId = parseInt(match[1], 10);

    console.log(`Captured terminal ID: ${testTerminalId} for use in tests`);

    // Verify the terminal exists
    const terminalInfo = TerminalRegistry.getTerminal(testTerminalId);
    assert.ok(terminalInfo, 'Terminal should exist in registry');
  });

  test('Get output from a terminal', async function () {
    // Ensure we have a terminal ID from the setup test
    assert.ok(testTerminalId, 'Terminal ID should be set from previous test');

    // Run a command with a specific output
    const marker = `specific-output-${Date.now()}`;
    await execTool.execute(`echo "${marker}"`, undefined, false);

    // Get output from the terminal
    const output = await waitForTerminalOutput(getOutputTool, testTerminalId, new RegExp(marker));

    // Verify the output contains the expected content
    assert.match(output, new RegExp(marker), 'Terminal output should contain the expected command output');
  });

  test('Get output with line limit', async function () {
    this.retries(2);
    const prefix = `LimitLine-${Date.now()}`;
    // Generate a lot of output lines
    await execTool.execute(`for i in $(seq 1 50); do echo "${prefix}-$i"; done`, undefined, false);

    // Get output with a limit of 10 lines
    const output = await waitForTerminalOutput(getOutputTool, testTerminalId, new RegExp(`${prefix}-50`), 10);

    // Count the number of lines in the response
    const outputLines = output.split('\n');

    // The first few lines are the tool's response metadata, so we check if the total is less than a reasonable limit
    assert.ok(outputLines.length < 20, 'Output should be limited to around 10 lines plus metadata');

    // Verify we have the last lines of output
    assert.match(output, new RegExp(`${prefix}-(4[0-9]|50)`), 'Output should contain the last lines');
  });

  test('Get output from non-existent terminal', async function () {
    // Try to get output from a non-existent terminal ID
    const response = await getOutputTool.execute(99999);

    // Verify we get an appropriate error message
    assert.match(response.text, /not found/, 'Should indicate terminal not found');
  });

  test('Get output after background command', async function () {
    const startMarker = `bg-start-${Date.now()}`;
    const endMarker = `bg-end-${Date.now()}`;
    // Run a command in background mode
    const [userRejected, cmdResponse] = await execTool.execute(`echo "${startMarker}" && sleep 1 && echo "${endMarker}"`, undefined, false, true);

    assert.strictEqual(userRejected, false, 'Command should not be user rejected');
    // New message wording: "Command started in background and continues in terminal ..."
    assert.match(cmdResponse.text, /started in background/i, 'Response should indicate background execution');

    // Extract terminal ID if needed, or use the existing one
    let bgTerminalId = testTerminalId;
    const match = cmdResponse.text.match(/terminal \(id: (\d+)\)/);
    if (match) {
      bgTerminalId = parseInt(match[1], 10);
    }

    // Get output after background command completed
    const output = await waitForTerminalOutput(getOutputTool, bgTerminalId, new RegExp(endMarker), 1000, 16, 250);

    // Verify we can see both parts of the output
    assert.match(output, new RegExp(startMarker), 'Output should contain first part of command');
    assert.match(output, new RegExp(endMarker), 'Output should contain the delayed part of command');
  });
});
