import * as assert from 'assert';
import * as vscode from 'vscode';
import { RipgrepLanguageModelTool } from '../../tools/ripgrep';

suite('Ripgrep Tool Test Suite', function () {
	const lmTool = new RipgrepLanguageModelTool();

	test('prepareInvocation renders glob on the detail line', function () {
		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: '\\A',
				detail: 'files',
				glob: ['**/set_env.sh'],
				includeHidden: true,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.match(invocationValue, /• Detail: `files` · glob: `\*\*\/set_env\.sh`/);
	});

	test('prepareInvocation hides CWD when it matches the workspace root', function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspaceRoot);

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				cwd: workspaceRoot,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.doesNotMatch(invocationValue, /• CWD:/);
	});

	test('prepareInvocation shows CWD when it differs from the workspace root', function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspaceRoot);
		const differentCwd = `${workspaceRoot}-other`;

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				cwd: differentCwd,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(invocationValue.includes(`• CWD: \`${differentCwd}\``));
	});
});