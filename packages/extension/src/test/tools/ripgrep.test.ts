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

		assert.match(invocationValue, /- Detail: `files` · glob: `\*\*\/set_env\.sh`/);
	});
});