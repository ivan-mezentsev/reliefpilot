// Speech transcription authorization utilities for API token management
// Stores context reference and provides token read/write operations
import * as vscode from 'vscode'

const SPEECH_API_KEY_SECRET_KEY = 'reliefpilot.speech.apiKey'

let extensionContext: vscode.ExtensionContext | undefined

export function initSpeechAuth(context: vscode.ExtensionContext): void {
    extensionContext = context
}

const NONE_MARKER = 'none'

async function getRawSecret(key: string): Promise<string | undefined> {
    if (!extensionContext) return undefined
    const value = await extensionContext.secrets.get(key)
    return value && value.trim().length > 0 ? value.trim() : undefined
}

async function getSecret(key: string): Promise<string | undefined> {
    const raw = await getRawSecret(key)
    if (raw === NONE_MARKER) return undefined
    return raw
}

async function updateSecret(options: {
    key: string
    title: string
    placeHolder: string
    password?: boolean
}): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: options.title,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true,
        password: options.password ?? false,
    })
    if (input === undefined) return undefined

    const trimmed = input.trim()
    if (!extensionContext) return undefined

    if (trimmed.length === 0) {
        await extensionContext.secrets.store(options.key, NONE_MARKER)
        void vscode.window.showInformationMessage(`Speech API token \`${options.title}\` cleared — requests will be sent without authorization.`)
        return NONE_MARKER
    }

    await extensionContext.secrets.store(options.key, trimmed)
    return trimmed
}

export async function setupOrUpdateSpeechApiKey(): Promise<string | undefined> {
    try {
        const value = await updateSecret({
            key: SPEECH_API_KEY_SECRET_KEY,
            title: 'SPEECH_API_KEY',
            placeHolder: 'Paste your speech transcription API key (SPEECH_API_KEY)',
            password: true,
        })
        if (value && value !== NONE_MARKER) {
            void vscode.window.showInformationMessage('Speech API token `SPEECH_API_KEY` stored securely.')
        }
        return value === NONE_MARKER ? undefined : value
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to store SPEECH_API_KEY token: ${message}`)
        return undefined
    }
}

export async function hasSpeechApiKey(): Promise<boolean> {
    return !!(await getSecret(SPEECH_API_KEY_SECRET_KEY))
}

export async function getSpeechApiKey(): Promise<string | undefined> {
    return await getSecret(SPEECH_API_KEY_SECRET_KEY)
}

/**
 * Returns true if the user has previously been prompted for the API key
 * (i.e. a value — real key or "none" — is stored in secrets).
 */
export async function isSpeechApiKeyConfigured(): Promise<boolean> {
    return !!(await getRawSecret(SPEECH_API_KEY_SECRET_KEY))
}

/**
 * If the API key has never been set, prompt the user.
 * The user can enter a key, or leave it empty to skip (stores "none").
 * Returns false only if the user dismissed the dialog (pressed Escape).
 */
export async function ensureSpeechApiKeyPrompted(): Promise<boolean> {
    if (await isSpeechApiKeyConfigured()) return true

    const input = await vscode.window.showInputBox({
        title: 'Speech API Key',
        placeHolder: 'Paste API key or leave empty to skip',
        prompt: 'Enter your speech transcription API key. Leave empty if your endpoint does not require authentication.',
        ignoreFocusOut: true,
        password: true,
    })

    // User pressed Escape — do not proceed
    if (input === undefined) return false

    if (!extensionContext) return false

    const trimmed = input.trim()
    if (trimmed.length === 0) {
        await extensionContext.secrets.store(SPEECH_API_KEY_SECRET_KEY, NONE_MARKER)
    } else {
        await extensionContext.secrets.store(SPEECH_API_KEY_SECRET_KEY, trimmed)
    }
    return true
}
