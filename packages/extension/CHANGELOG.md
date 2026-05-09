# Changelog

## 1.4.0 - 2026-05-09

- docs(readme): update ripgrep usage instructions for name/path discovery
- feat(execute_command): enhance invocation message handling in tests
- style: improve markdown formatting in invocation messages
- feat(ripgrep): enhance CWD handling in invocation messages
- style: update markdown formatting for invocation messages
- feat(ripgrep): add glob handling in prepareInvocation method
- feat(read_file): enhance range handling in ReadFileTool
- feat(read_file): enhance invocation handling for file paths
- feat(extension): add List Directory tool and enhance invocation handling
- feat(extension): add List Directory tool for directory content listing
- docs(extension): update web search recommendations in README
- chore(extension): update jsdom dependency and refactor asset copying
- feat(read_file): enhance file reading with improved offset handling
- chore(pnpm): update workspace configuration
- feat(read_file): enhance file reading with negative offset support

## 1.3.1 - 2026-05-04

- feat(pr_read_file): enhance file reading capabilities with range support

## 1.3.0 - 2026-05-04

- feat(read_file): add tool for reading file contents with offset and limit
- feat(rp_read_file): enhance Copilot chat session resource handling

## 1.2.1 - 2026-05-03

- docs(extension): update Google Search tool description and API details
- feat(ask_report): integrate KaTeX for math rendering in markdown

## 1.2.0 - 2026-05-01

- feat(google_search): Brought back Google Search tool integration (This still to work for old users within the limits - let's try your old API keys)

## 1.1.0 - 2026-04-30

- feat(settings): add recommended settings panel and apply functionality
- docs(readme): update README with VSCode version recommendation and Copilot notice
- feat(extension): change default model selection `ai_fetch_url` to show all models

## 1.0.2 - 2026-04-27

- feat(github_search_code): implement rate limit handling in GitHub API requests

## 1.0.1 - 2026-03-28

- docs: update examples in README for ripgrep usage
- chore(extension): remove Google search integration (Google ended support for this API)

## 1.0.0 - 2026-03-21

- feat: add voice input (speech-to-text) for ask_report and halt_for_feedback panels (#24, thanks @jackkru69)
- feat(tests): implement custom test runner and event reporting

## 0.9.2 - 2026-03-07

- docs(execute_command, get_terminal_output): update model descriptions
- feat(terminal): include terminal ID in terminal name during creation

## 0.9.1 - 2026-02-24

- feat(terminal): improve new terminal initialization process
- fix(exa): enhance error handling for Exa API token validation
- fix(validate_linkup_token): refine token validation logic

## 0.9.0 - 2026-02-21

- feat(exa): add Exa search tool and API integration

## 0.8.0 - 2026-02-17

- feat(linkup): add Linkup search functionality and API integration

## 0.7.1 - 2026-02-11

- fix(terminal): remove timeout for execution stream tracking

## 0.7.0 - 2026-02-11

- feat(terminal): add newTerminal option for command execution
- eat(terminal): enhance terminal command execution handling
- fix(language-model): update registration of language model tools

## 0.6.4 - 2026-02-08

- feat(ai_fetch_url): enhance model selection with toggle for Copilot models

## 0.6.3 - 2026-02-07

- feat(confirmation_ui): enhance button location support in input boxes

## 0.6.2 - 2026-02-05

- feat(halt_for_feedback): add ESC key to closes the panel and resumes work

## 0.6.1 - 2026-02-04

- feat(ai_fetch_url): enhance fetch logic with retryable attempts

## 0.6.0 - 2026-02-01

- feat(haltForFeedback): implement halt for feedback functionality

## 0.5.1 - 2026-02-01

- fix(execute_command): enhance markdown rendering for command output

## 0.5.0 - 2026-01-31

- feat(ai_fetch_url): add includeLinks option to preserve links in output

## 0.4.1 - 2026-01-25

- fix(ask_report): inline bootstrap payload to prevent blank webview (#9)

## 0.4.0 - 2026-01-22

- feat(ripgrep): add ripgrep language model tool for file searching

## 0.3.2 - 2025-12-19

- chore(package): update description

## 0.3.1 - 2025-12-19

- feat(ai_fetch_url): unfiltered model selection
- refactor(ai_fetch_sessions): improve session finalization and error handling

## 0.3.0 - 2025-12-13

- feat(github): add GitHub directory contents tool
- feat(ai_fetch_url): enhance system prompt for topic extraction

## 0.2.1 - 2025-11-24

- refactor(ai_fetch_sessions): enhance session management and lifecycle states

## 0.2.0 - 2025-11-20

- refactor(confirmation_ui): dispose input boxes after use
- refactor(tools): session management with cache eviction and persistence
- refactor(ai_fetch_url): improve system prompt structure and clarity

## 0.1.2 - 2025-11-19

- refactor(terminal): use singleton and cleanup terminals on close
- docs(extension): add HARDMUST rule for autonomous long-running services
- docs(extension): require immediate analysis of execute_command output

## 0.1.1 - 2025-11-18

- fix(extension): update ai_fetch_url prompt to remove image links
- feat(extension): add command to show Ask Report history
- Implemented a method to remove entries from the Ask Report history.

## 0.1.0 - 2025-11-15

- Initial public release
