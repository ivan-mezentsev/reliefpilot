import * as assert from 'assert'
import * as vscode from 'vscode'
import { askReport, AskUserResult } from '../../tools/ask_report'
import { initEnv } from '../../utils/env'

//suite.skip('Ask Report Manual/Timeout Demo Test', function () {
suite('Ask Report Manual/Timeout Demo Test', function () {
    // Allow up to 40s for manual answer or 30s timeout + margin
    this.timeout(40000)

    let originalTimeout: number | undefined

    suiteSetup(async () => {
        // Initialize env exactly as in production: find extension using VS Code API
        // Read publisher and name from extension.packageJSON (official API way)
        const extension = vscode.extensions.all.find((ext) => {
            const pkg = ext.packageJSON
            return pkg && pkg.name === 'reliefpilot'
        })
        if (!extension) {
            throw new Error('Relief Pilot extension not found. Cannot initialize env for tests.')
        }
        await extension.activate()
        const mockContext = {
            extensionUri: extension.extensionUri,
            extension: extension,
        } as vscode.ExtensionContext
        initEnv(mockContext)

        // Save and set the ask-report timeout to 30 seconds for this demo test
        const cfg = vscode.workspace.getConfiguration('reliefpilot')
        originalTimeout = cfg.get<number>('askReportTimeoutSeconds')
        await cfg.update('askReportTimeoutSeconds', 30, vscode.ConfigurationTarget.Global)
    })

    suiteTeardown(async () => {
        // Restore original value
        const cfg = vscode.workspace.getConfiguration('reliefpilot')
        await cfg.update('askReportTimeoutSeconds', originalTimeout ?? 600, vscode.ConfigurationTarget.Global)
    })

    test('Gives 30s for manual response or auto-timeout', async () => {
        // Show a simple ask-report dialog. Tester can pick an option or wait for timeout.
        const promise = askReport({
            title: 'Ask Report — 30s Demo',
            markdown: '# Test Report with Rich Markdown\n\n## Introduction\nThis is a test report demonstrating the rich capabilities of Markdown with code blocks in various programming languages. We will look at code examples, tables, lists, and other formatting elements.\n\n## Code Examples\n\n### No langs\n```\none line\n```\n\n### Python\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    else:\n        return fibonacci(n-1) + fibonacci(n-2)\n\n# Example usage\nfor i in range(10):\n    print(f"F({i}) = {fibonacci(i)}")\n```\n\n### JavaScript\n```javascript\nconst express = require(\'express\');\nconst app = express();\n\napp.get(\'/\', (req, res) => {\n    res.json({ message: \'Hello, World!\' });\n});\n\napp.listen(3000, () => {\n    console.log(\'Server running on port 3000\');\n});\n```\n\n### Bash\n```bash\n#!/bin/bash\n\n# Function to check if a file exists\ncheck_file() {\n    if [ -f "$1" ]; then\n        echo "File $1 exists"\n    else\n        echo "File $1 not found"\n    fi\n}\n\n# Example usage\ncheck_file "/etc/passwd"\ncheck_file "/nonexistent/file"\n```\n\n### Go\n```go\npackage main\n\nimport (\n    "fmt"\n    "net/http"\n)\n\nfunc handler(w http.ResponseWriter, r *http.Request) {\n    fmt.Fprintf(w, "Hello, %s!", r.URL.Path[1:])\n}\n\nfunc main() {\n    http.HandleFunc("/", handler)\n    http.ListenAndServe(":8080", nil)\n}\n```\n\n### SQL\n```sql\n-- Create users table\nCREATE TABLE users (\n    id SERIAL PRIMARY KEY,\n    username VARCHAR(50) UNIQUE NOT NULL,\n    email VARCHAR(100) UNIQUE NOT NULL,\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Insert data\nINSERT INTO users (username, email) VALUES\n(\'alice\', \'alice@example.com\'),\n(\'bob\', \'bob@example.com\');\n\n-- Select data\nSELECT * FROM users WHERE created_at > \'2023-01-01\';\n```\n\n## Language Comparison Table\n\n| Language   | Type           | Popularity    | Usage                |\n|------------|----------------|---------------|----------------------|\n| Python     | Interpreted    | High          | Web, AI, scripts     |\n| JavaScript | Interpreted    | Very high     | Web, Node.js         |\n| Bash       | Scripting      | Medium        | Automation           |\n| Go         | Compiled       | High          | Servers, cloud       |\n| SQL        | Declarative    | High          | Databases            |\n\n## Lists\n\n### Numbered List\n1. Installing dependencies\n2. Configuring settings\n3. Running the application\n4. Testing functionality\n\n### Bulleted List\n- **Security**: Regular updates\n- **Performance**: Code optimization\n- **Documentation**: Detailed comments\n- **Testing**: Test coverage > 80%\n\n## Mathematical Formulas\n\n### Inline Formula\nArea of a circle: $A = \pi r^2$\n\n### Block Formula\n$\n\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}\n$\n\n## Links and Images\n\n### Links\n- [GitHub](https://github.com)\n- [Stack Overflow](https://stackoverflow.com)\n\n### Image (example)\n![Example image](https://via.placeholder.com/300x200?text=Test+Image)\n\n\n## Flowchart\n\n```mermaid\nflowchart LR\nA[Hard] -->|Text| B(Round)\nB --> C{Decision}\nC -->|One| D[Result 1]\nC -->|Two| E[Result 2]\n```\n\n## Sequence diagram\n\n```mermaid\nsequenceDiagram\nAlice->>John: Hello John, how are you?\nloop HealthCheck\n    John->>John: Fight against hypochondria\nend\nNote right of John: Rational thoughts!\nJohn-->>Alice: Great!\nJohn->>Bob: How about you?\nBob-->>John: Jolly good!\n```\n\nThat is, the actual scheme is as follows:\n\n\n$$\n\\text{ChatGPT session cookie} \\rightarrow \\text{/api/auth/session} \\rightarrow \\text{short-lived access token} \\rightarrow \\text{ChatGPT web backend}\n$$\n## Conclusion\nThis report demonstrates the variety of Markdown elements, including code blocks in different languages, tables, lists, formulas, and links. Everything is ready for testing!\n',
            predefinedOptions: ['Yes', 'No'],
        })

        // Await user interaction or timeout resolution
        const result: AskUserResult = await promise

        // Accept either a manual Submit or an auto-timeout Cancel
        const isSubmit = result.decision === 'Submit'
        const isTimeoutCancel = result.decision === 'Cancel' && result.timeout === true

        assert.ok(
            isSubmit || isTimeoutCancel,
            `Expected Submit or Cancel with timeout, got ${JSON.stringify(result)}`,
        )

        if (isSubmit) {
            // When submitted, ensure a non-empty value for predefined option path
            assert.ok(result.value.length > 0, 'Submit should carry a non-empty value')
        }
    })
})
