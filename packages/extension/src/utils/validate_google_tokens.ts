import * as vscode from 'vscode'

export async function validateGoogleTokensFromResponse(status: number, rawText: string): Promise<boolean> {
    if (status !== 400 && status !== 403) return false

    let parsed: any
    try {
        parsed = JSON.parse(rawText)
    } catch {
        return false
    }

    if (status === 403) {
        const phrase = "Method doesn't allow unregistered callers"
        const topMsg = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        const list = Array.isArray(parsed?.error?.errors) ? parsed.error.errors : []
        const hasPhraseTop = topMsg.includes(phrase)
        const hasPhraseInList = list.some((e: any) => typeof e?.message === 'string' && e.message.includes(phrase))
        if (hasPhraseTop || hasPhraseInList) {
            let entered: string | undefined
            try {
                entered = await vscode.commands.executeCommand('reliefpilot.google.setupApiKey')
            } catch {
                entered = undefined
            }
            if (entered) {
                return true
            }
        }
    }

    if (status === 400) {
        const phrase = 'API key not valid. Please pass a valid API key'
        const topMsg = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        const list = Array.isArray(parsed?.error?.errors) ? parsed.error.errors : []
        const hasPhraseTop = topMsg.includes(phrase)
        const hasPhraseInList = list.some((e: any) => typeof e?.message === 'string' && e.message.includes(phrase))
        if (hasPhraseTop || hasPhraseInList) {
            let entered: string | undefined
            try {
                entered = await vscode.commands.executeCommand('reliefpilot.google.setupApiKey')
            } catch {
                entered = undefined
            }
            if (entered) {
                return true
            }
        }
    }

    if (status === 400) {
        const phrase = 'Request contains an invalid argument'
        const topMsg = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
        const list = Array.isArray(parsed?.error?.errors) ? parsed.error.errors : []
        const hasPhraseTop = topMsg.includes(phrase)
        const hasPhraseInList = list.some((e: any) => typeof e?.message === 'string' && e.message.includes(phrase))
        if (hasPhraseTop || hasPhraseInList) {
            let entered: string | undefined
            try {
                entered = await vscode.commands.executeCommand('reliefpilot.google.setupSearchEngineId')
            } catch {
                entered = undefined
            }
            if (entered) {
                return true
            }
        }
    }

    return false
}
