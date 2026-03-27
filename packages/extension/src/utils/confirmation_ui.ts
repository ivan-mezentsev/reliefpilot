import * as vscode from 'vscode'

export interface CommandConfirmationResult {
  decision: 'Approve' | 'Deny'
  command: string
  feedback?: string
  source: 'vscode' | 'telegram'
}

export interface CommandConfirmationSession {
  readonly result: Promise<CommandConfirmationResult>
  applyExternalResolution(result: {
    approved: boolean
    updatedCommand?: string | null
    feedback?: string | null
    source: 'telegram' | 'vscode'
  }): void
}

/**
 * InputBox
 */
export class ConfirmationUI {
  /**
   * Show an InputBox-based confirmation with editable command text.
   * Returns the user's decision and the (possibly edited) command.
   */
  static async confirmCommandWithInputBox(
    message: string,
    initialCommand: string,
    approveLabel: string,
    denyLabel: string,
  ): Promise<{ decision: 'Approve' | 'Deny'; command: string; feedback?: string }> {
    const session = this.createCommandConfirmationSession(message, initialCommand, approveLabel, denyLabel)
    const result = await session.result
    return {
      decision: result.decision,
      command: result.command,
      feedback: result.feedback,
    }
  }

  static createCommandConfirmationSession(
    message: string,
    initialCommand: string,
    approveLabel: string,
    denyLabel: string,
  ): CommandConfirmationSession {
    const inputBox = vscode.window.createInputBox()
    inputBox.title = message
    inputBox.value = initialCommand
    // Place cursor at the start without selection.
    inputBox.valueSelection = [0, 0]
    inputBox.ignoreFocusOut = true

    const supportsQuickInputButtonLocation = typeof (vscode as any).QuickInputButtonLocation?.Inline === 'number'

    const approveButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: approveLabel,
    }
    if (supportsQuickInputButtonLocation) {
      (approveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2
    }

    const denyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('x'),
      tooltip: denyLabel,
    }
    inputBox.buttons = [approveButton, denyButton]

    let feedbackInputBox: vscode.InputBox | undefined
    let handled = false // set true when approve/deny button is used
    let resolved = false

    let resolveResult!: (result: CommandConfirmationResult) => void
    const result = new Promise<CommandConfirmationResult>((resolve) => {
      resolveResult = resolve
    })

    // Dispose both layers safely so VS Code and Telegram cannot race the UI into
    // leaving an orphaned quick input behind.
    const disposeInputs = () => {
      try { feedbackInputBox?.hide() } catch { /* ignore */ }
      try { feedbackInputBox?.dispose() } catch { /* ignore */ }
      feedbackInputBox = undefined
      try { inputBox.hide() } catch { /* ignore */ }
      try { inputBox.dispose() } catch { /* ignore */ }
    }

    const finalize = (nextResult: CommandConfirmationResult) => {
      if (resolved) {
        return
      }

      resolved = true
      handled = true
      disposeInputs()
      resolveResult(nextResult)
    }

    const approve = (source: 'vscode' | 'telegram', commandOverride?: string | null) => {
      const command = commandOverride ?? (source === 'vscode' ? inputBox.value : initialCommand)
      finalize({
        decision: 'Approve',
        command,
        source,
      })
    }

    const deny = (source: 'vscode' | 'telegram', feedback?: string | null) => {
      finalize({
        decision: 'Deny',
        command: initialCommand,
        feedback: feedback ?? undefined,
        source,
      })
    }

    // Ask optional feedback similar to other UIs.
    const showFeedbackPrompt = () => {
      handled = true
      inputBox.hide()

      const fb = vscode.window.createInputBox()
      feedbackInputBox = fb
      fb.title = 'Feedback'
      fb.placeholder = 'Add context for the agent (optional)'
      fb.ignoreFocusOut = true

      const fbApproveButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('send'),
        tooltip: 'Send feedback',
      }
      if (supportsQuickInputButtonLocation) {
        (fbApproveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2
      }

      const fbBackButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('arrow-left'),
        tooltip: 'Back to command',
      }
      fb.buttons = [fbApproveButton, fbBackButton]

      let sent = false

      const sendFeedback = () => {
        sent = true
        deny('vscode', fb.value.trim() || undefined)
      }

      fb.onDidAccept(() => {
        sendFeedback()
      })

      fb.onDidTriggerButton((btn) => {
        if (btn === fbApproveButton) {
          sendFeedback()
          return
        }

        if (btn === fbBackButton) {
          fb.hide()
          fb.dispose()
          feedbackInputBox = undefined
          handled = false
          inputBox.show()
        }
      })

      fb.onDidHide(() => {
        // ESC/close or Back button => return to command (unless feedback was sent).
        if (resolved || sent) {
          return
        }

        try { fb.dispose() } catch { /* ignore */ }
        feedbackInputBox = undefined
        handled = false
        inputBox.show()
      })

      fb.show()
    }

    inputBox.onDidTriggerButton((btn) => {
      if (btn === approveButton) {
        approve('vscode')
      } else if (btn === denyButton) {
        showFeedbackPrompt()
      }
    })

    inputBox.onDidAccept(() => {
      // Enter acts as Approve.
      approve('vscode')
    })

    inputBox.onDidHide(() => {
      // ESC/close behaves like clicking Deny -> open feedback flow.
      if (!resolved && !handled) {
        showFeedbackPrompt()
      }
    })

    inputBox.show()

    return {
      result,
      applyExternalResolution: (externalResult) => {
        if (externalResult.approved) {
          approve(externalResult.source, externalResult.updatedCommand ?? null)
          return
        }

        deny(externalResult.source, externalResult.feedback ?? null)
      },
    }
  }

  /**
   * Shows an InputBox-based confirmation UI.
   * @param message Confirmation message.
   * @param detail Additional details (e.g., command).
   * @param approveLabel Label for the approve button.
   * @param denyLabel Label for the deny button.
   * @returns "Approve" if approved, or "Deny" or a reason text if denied.
   */
  static async confirm(message: string, detail: string, approveLabel: string, denyLabel: string): Promise<string> {
    return await this.showInputBoxConfirmation(message, detail, approveLabel, denyLabel)
  }

  /**
   * Show an InputBox-based confirmation with approve/deny buttons.
   * Unlike confirmCommandWithInputBox, any edited value is ignored and only a decision or feedback is returned.
   */
  private static async showInputBoxConfirmation(
    message: string,
    detail: string,
    approveLabel: string,
    denyLabel: string,
  ): Promise<string> {
    const inputBox = vscode.window.createInputBox()
    inputBox.title = message
    inputBox.value = detail || ''
    inputBox.placeholder = detail ? '' : ''
    inputBox.ignoreFocusOut = true

    const supportsQuickInputButtonLocation = typeof (vscode as any).QuickInputButtonLocation?.Inline === 'number'

    const approveButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: approveLabel,
    }
    const denyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('x'),
      tooltip: denyLabel,
    }
    inputBox.buttons = [approveButton, denyButton]

    return await new Promise<string>((resolve) => {
      let handled = false
      const approve = () => {
        handled = true
        inputBox.hide()
        inputBox.dispose()
        resolve('Approve')
      }
      const deny = async () => {
        handled = true
        inputBox.hide()

        // Ask optional feedback similar to other UIs.
        const fb = vscode.window.createInputBox()
        fb.title = 'Feedback'
        fb.placeholder = 'Add context for the agent (optional)'
        fb.ignoreFocusOut = true
        const fbApproveButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('send'),
          tooltip: 'Send feedback',
        }
        if (supportsQuickInputButtonLocation) {
          (fbApproveButton as any).location = (vscode as any).QuickInputButtonLocation?.Inline ?? 2
        }
        const fbBackButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('arrow-left'),
          tooltip: 'Back to confirmation',
        }
        fb.buttons = [fbApproveButton, fbBackButton]
        let sent = false
        fb.onDidAccept(() => {
          sent = true
          const feedback = fb.value.trim()
          fb.hide()
          fb.dispose()
          inputBox.dispose()
          resolve(feedback || 'Deny')
        })
        fb.onDidTriggerButton((btn) => {
          if (btn === fbApproveButton) {
            sent = true
            const feedback = fb.value.trim()
            fb.hide()
            fb.dispose()
            inputBox.dispose()
            resolve(feedback || 'Deny')
          } else if (btn === fbBackButton) {
            fb.hide()
            fb.dispose()
          }
        })
        fb.onDidHide(() => {
          // ESC/close or Back button => return to main input (unless feedback was sent).
          if (!sent) {
            handled = false
            fb.dispose()
            inputBox.show()
          }
        })
        fb.show()
      }

      inputBox.onDidTriggerButton((btn) => {
        if (btn === approveButton) {
          approve()
        } else if (btn === denyButton) {
          deny()
        }
      })
      inputBox.onDidAccept(() => {
        approve()
      })
      inputBox.onDidHide(() => {
        if (!handled) {
          deny()
        }
      })
      inputBox.show()
    })
  }
}
