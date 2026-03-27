import * as vscode from 'vscode'

const TELEGRAM_BOT_TOKEN_SECRET_KEY = 'reliefpilot.telegram.botToken'

let extensionContext: vscode.ExtensionContext | undefined

export function initTelegramAuth(context: vscode.ExtensionContext): void {
  extensionContext = context
}

async function getRawSecret(): Promise<string | undefined> {
  if (!extensionContext) return undefined
  const value = await extensionContext.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY)
  return value && value.trim().length > 0 ? value.trim() : undefined
}

export async function getTelegramBotToken(): Promise<string | undefined> {
  return await getRawSecret()
}

export async function hasTelegramBotToken(): Promise<boolean> {
  return !!(await getRawSecret())
}

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35,}$/

export async function setupOrUpdateTelegramBotToken(): Promise<string | undefined> {
  if (!extensionContext) return undefined

  const input = await vscode.window.showInputBox({
    title: 'TELEGRAM_BOT_TOKEN',
    placeHolder: 'Paste your Telegram Bot token from @BotFather (format: 123456:ABC-DEF...)',
    ignoreFocusOut: true,
    password: true,
    validateInput: (value) => {
      const trimmed = value.trim()
      if (trimmed.length === 0) return 'Token cannot be empty'
      if (!BOT_TOKEN_REGEX.test(trimmed)) return 'Invalid token format. Expected: NNN:XXXXX (from @BotFather)'
      return undefined
    },
  })

  if (input === undefined) return undefined

  const trimmed = input.trim()
  try {
    await extensionContext.secrets.store(TELEGRAM_BOT_TOKEN_SECRET_KEY, trimmed)
    void vscode.window.showInformationMessage('Telegram Bot token stored securely.')
    return trimmed
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Failed to store Telegram Bot token: ${message}`)
    return undefined
  }
}
