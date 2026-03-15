import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ensureSpeechApiKeyPrompted, getSpeechApiKey } from './speech_auth'

// ── Types ────────────────────────────────────────────────────────────

type LinuxInputBackend = 'pulse' | 'alsa'

interface SpeechConfig {
    apiKey: string
    endpointBase: string
    model: string
    language: string
}

export interface StreamingRecordingSession {
    stop(): void
    cancel(): void
}

// ── Configuration ────────────────────────────────────────────────────

function getConfig() {
    return vscode.workspace.getConfiguration('reliefpilot')
}

function getLinuxBackends(): LinuxInputBackend[] {
    const value = (getConfig().get<string>('speechLinuxInputBackend', 'auto') ?? 'auto').toLowerCase().trim()
    if (value === 'pulse') return ['pulse']
    if (value === 'alsa') return ['alsa']
    return ['pulse', 'alsa']
}

function getLinuxDevice(): string {
    return (getConfig().get<string>('speechLinuxInputDevice', 'default') ?? 'default').trim() || 'default'
}

function getWindowsDevice(): string {
    return (getConfig().get<string>('speechWindowsDevice', '') ?? '').trim()
}

function getMacDevice(): string {
    return (getConfig().get<string>('speechMacDevice', '') ?? '').trim()
}

async function getSpeechConfig(): Promise<SpeechConfig> {
    const config = getConfig()
    const apiKey = ((await getSpeechApiKey()) ?? '').trim()
    const endpointBase = (config.get<string>('speechTranscriptionEndpoint', '') ?? '').trim().replace(/\/+$/, '')
    const model = (config.get<string>('speechModel', '') ?? '').trim()
    const language = config.get<string>('speechLanguage', '') ?? ''
    return { apiKey, endpointBase, model, language }
}

// ── FFmpeg ────────────────────────────────────────────────────────────

export function buildFfmpegArgs(opts: { outputFile: string; chunkSeconds?: number; linuxBackend?: LinuxInputBackend; windowsDevice?: string; macDevice?: string }): string[] {
    const common = ['-ar', '16000', '-ac', '1']
    const duration = typeof opts.chunkSeconds === 'number' ? ['-t', String(opts.chunkSeconds)] : []

    if (process.platform === 'linux') {
        const backend = opts.linuxBackend ?? 'pulse'
        return ['-f', backend, '-i', getLinuxDevice(), ...common, ...duration, '-y', opts.outputFile]
    }
    if (process.platform === 'darwin') {
        const dev = opts.macDevice || ':default'
        return ['-f', 'avfoundation', '-i', dev, ...common, ...duration, '-y', opts.outputFile]
    }
    const dev = opts.windowsDevice ?? 'default'
    return ['-f', 'dshow', '-i', `audio=${dev}`, ...common, ...duration, '-y', opts.outputFile]
}

function spawnFfmpeg(args: string[]): { proc: ChildProcess; getStderr: () => string } {
    let stderrText = ''
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr?.on('data', (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderrText = (stderrText + s).slice(-8192)
    })
    return { proc, getStderr: () => stderrText }
}

function describeFfmpegFailure(stderrText: string): string {
    return stderrText.trim().split('\n').slice(-6).join('\n').trim() || 'unknown FFmpeg error'
}

// ── File readiness polling ───────────────────────────────────────────

async function waitForFileReady(filePath: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    let lastSize = -1
    let stableCount = 0

    while (Date.now() - started < timeoutMs) {
        try {
            const size = fs.statSync(filePath).size
            if (size > 1000) {
                if (size === lastSize) {
                    if (++stableCount >= 2) return true
                } else {
                    stableCount = 0
                    lastSize = size
                }
            }
        } catch { /* file may not exist yet */ }
        await new Promise((r) => setTimeout(r, 120))
    }
    return false
}

// ── Whisper hallucination filter ─────────────────────────────────────

const HALLUCINATION_PHRASES = [
    'продолжение следует',
    'субтитры сделал',
    'субтитры создавал',
    'подписывайтесь на канал',
    'спасибо за просмотр',
    'thank you for watching',
    'thanks for watching',
    'please subscribe',
    'like and subscribe',
    'subtitles by',
    'sous-titres',
    'untertitel',
]

const BRACKET_MARKER_RE = /\[(?:BLANK_AUDIO|SILENCE|MUSIC|APPLAUSE|LAUGHTER|NOISE|INAUDIBLE)\]/gi

export function isHallucination(text: string): boolean {
    const stripped = text.replace(BRACKET_MARKER_RE, '').trim()
    if (!stripped) return true
    const lower = stripped.toLowerCase()
    return HALLUCINATION_PHRASES.some((h) => lower.includes(h))
}

// ── Transcription ────────────────────────────────────────────────────

/**
 * Transcribe audio buffer via the configured speech-to-text endpoint.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
    const { apiKey, endpointBase, model, language } = await getSpeechConfig()
    if (!endpointBase) {
        throw new Error('Speech transcription endpoint is not configured. Set "reliefpilot.speechTranscriptionEndpoint" in settings.')
    }

    const boundary = '----ReliefPilotSpeech' + randomUUID()
    const parts: Buffer[] = []

    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ))
    parts.push(audioBuffer)
    parts.push(Buffer.from('\r\n'))
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    ))
    if (language) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`,
        ))
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`,
    ))
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)
    const headers: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
    }

    const resp = await fetch(`${endpointBase}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
    })

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`Speech transcription error ${resp.status}: ${errText}`)
    }

    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
        const json = await resp.json() as {
            text?: string
            segments?: Array<{ text?: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }>
        }
        // If verbose_json with segments is available, filter out hallucinated segments
        if (json.segments && json.segments.length > 0) {
            const NO_SPEECH_THRESHOLD = 0.6
            const meaningful = json.segments
                .filter((s) => (s.no_speech_prob ?? 0) < NO_SPEECH_THRESHOLD)
                .map((s) => s.text ?? '')
                .join('')
                .trim()
            return meaningful
        }
        return json.text ?? ''
    }
    return (await resp.text().catch(() => '')).trim()
}

/** Transcribe a buffer and emit the result only if meaningful. */
async function transcribeAndEmit(buf: Buffer, onText: (text: string) => void, transcriber?: (buf: Buffer) => Promise<string>): Promise<void> {
    if (buf.length < 1000) return
    const text = (await (transcriber ?? transcribeAudio)(buf)).trim()
    if (text && !isHallucination(text)) {
        onText(text)
    }
}

// ── Streaming recording ──────────────────────────────────────────────

/**
 * Start streaming recording: records audio in chunks, transcribes each chunk,
 * and calls onText with intermediate results in real time.
 *
 * @internal `_test` — optional overrides for spawn / transcription used in unit tests.
 */
export function startStreamingRecording(opts: {
    onText: (text: string) => void
    onEnd: () => void
    onError: (err: Error) => void
    chunkSeconds?: number
    /** @internal test-only overrides */
    _test?: {
        spawnFfmpeg?: (args: string[]) => { proc: ChildProcess; getStderr: () => string }
        transcribeAudio?: (buf: Buffer) => Promise<string>
    }
}): StreamingRecordingSession {
    const chunkSec = opts.chunkSeconds ?? 3
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefpilot-stream-'))
    const prefix = path.basename(tmpDir)
    let chunkIndex = 0
    let proc: ChildProcess | undefined
    let cancelled = false
    let stopping = false
    let linuxBackendIdx = 0
    let stderrGetter: (() => string) | undefined
    let chunkCloseResolver: (() => void) | undefined
    let resolvedWindowsDevice: string | undefined
    let resolvedMacDevice: string | undefined

    // ── Ordered emission queue ───────────────────────────────────
    // Each chunk gets a sequential index. Transcription results are
    // collected in a map and flushed in order so that network jitter
    // does not scramble the dictated text.
    let nextEmitIndex = 0
    const pendingEmits = new Map<number, string | null>()

    function enqueueEmit(idx: number, text: string | null) {
        pendingEmits.set(idx, text)
        flushEmits()
    }

    function flushEmits() {
        while (pendingEmits.has(nextEmitIndex)) {
            const text = pendingEmits.get(nextEmitIndex)!
            pendingEmits.delete(nextEmitIndex)
            nextEmitIndex++
            if (text) opts.onText(text)
        }
    }

    const chunkFile = () => path.join(tmpDir, `${prefix}-${chunkIndex}.wav`)

    function canFallbackLinuxBackend(): boolean {
        if (process.platform !== 'linux' || stopping) return false
        const backends = getLinuxBackends()
        return backends.length > 1 && linuxBackendIdx + 1 < backends.length
    }

    function startChunk() {
        if (cancelled || stopping) return

        const file = chunkFile()
        const backends = getLinuxBackends()
        const linuxBackend = process.platform === 'linux'
            ? (backends[linuxBackendIdx] ?? backends[0] ?? 'pulse')
            : undefined

        const ffmpegArgs = buildFfmpegArgs({ outputFile: file, chunkSeconds: chunkSec, linuxBackend, windowsDevice: resolvedWindowsDevice, macDevice: resolvedMacDevice })
        const started = (opts._test?.spawnFfmpeg ?? spawnFfmpeg)(ffmpegArgs)
        proc = started.proc
        stderrGetter = started.getStderr

        proc.on('close', () => {
            chunkCloseResolver?.()
            chunkCloseResolver = undefined
            if (cancelled) return

            const capturedFile = file
            const capturedIdx = chunkIndex
            void (async () => {
                try {
                    const ready = await waitForFileReady(capturedFile, 1500)
                    if (!ready) {
                        if (canFallbackLinuxBackend()) {
                            linuxBackendIdx++
                            startChunk()
                            return
                        }
                        if (!stopping) {
                            throw new Error(`Microphone recording failed: ${describeFfmpegFailure(stderrGetter?.() ?? '')}`)
                        }
                        return
                    }
                    const buf = fs.readFileSync(capturedFile)
                    fs.unlinkSync(capturedFile)
                    await transcribeAndEmit(buf, (text) => enqueueEmit(capturedIdx, text), opts._test?.transcribeAudio)
                    // If transcription produced no text, still mark slot as done
                    if (!pendingEmits.has(capturedIdx) && capturedIdx >= nextEmitIndex) {
                        enqueueEmit(capturedIdx, null)
                    }
                } catch (err) {
                    if (!stopping) {
                        cleanup()
                        opts.onError(err as Error)
                        return
                    }
                }
            })()

            chunkIndex++
            if (!cancelled && !stopping) startChunk()
        })

        proc.on('error', (err) => {
            if (!cancelled) {
                cleanup()
                opts.onError(err)
            }
        })
    }

    function cleanup() {
        cancelled = true
        stopping = false
        try { proc?.kill('SIGKILL') } catch { /* ignore */ }
        for (let i = 0; i <= chunkIndex; i++) {
            try { fs.unlinkSync(path.join(tmpDir, `${prefix}-${i}.wav`)) } catch { /* ignore */ }
        }
        try { fs.rmdirSync(tmpDir) } catch { /* ignore — may not be empty */ }
    }

    // Resolve platform-specific device once before starting chunks
    void (async () => {
        // Prompt for API key on first use (user can skip by leaving empty)
        if (!opts._test) {
            const proceed = await ensureSpeechApiKeyPrompted()
            if (!proceed) {
                opts.onEnd()
                return
            }
        }

        if (process.platform === 'win32') {
            const configured = getWindowsDevice()
            if (configured) {
                resolvedWindowsDevice = configured
            } else {
                const devices = await discoverWindowsAudioDevices()
                resolvedWindowsDevice = devices[0]
                if (!resolvedWindowsDevice) {
                    opts.onError(new Error(
                        'No DirectShow audio input device found. Install a microphone driver or set "reliefpilot.speechWindowsDevice" in settings.',
                    ))
                    return
                }
            }
        } else if (process.platform === 'darwin') {
            const configured = getMacDevice()
            if (configured) {
                resolvedMacDevice = configured
            } else {
                const devices = await discoverMacAudioDevices()
                resolvedMacDevice = devices.length > 0 ? `:${devices[0].index}` : undefined
                // macOS falls back to :default if no device discovered
            }
        }
        startChunk()
    })()

    return {
        stop() {
            if (cancelled || stopping) return
            stopping = true

            const waitForClose = new Promise<void>((resolve) => {
                chunkCloseResolver = resolve
                setTimeout(resolve, 2500)
            })
            try { proc?.kill('SIGINT') } catch { /* ignore */ }

            void (async () => {
                await waitForClose
                try {
                    const file = chunkFile()
                    const ready = await waitForFileReady(file, 2000)
                    if (ready && fs.existsSync(file)) {
                        const buf = fs.readFileSync(file)
                        fs.unlinkSync(file)
                        const lastIdx = chunkIndex
                        await transcribeAndEmit(buf, (text) => enqueueEmit(lastIdx, text), opts._test?.transcribeAudio)
                        if (!pendingEmits.has(lastIdx) && lastIdx >= nextEmitIndex) {
                            enqueueEmit(lastIdx, null)
                        }
                    }
                } catch { /* ignore last-chunk errors */ }
                cancelled = true
                stopping = false
                opts.onEnd()
            })()
        },
        cancel() {
            cleanup()
        },
    }
}

// ── User prompts ─────────────────────────────────────────────────────

/**
 * Discover available audio input devices on Windows using FFmpeg dshow.
 * Returns a list of device names (e.g. ["Microphone (Realtek High Definition Audio)"]).
 * Falls back to empty array on error.
 */
export async function discoverWindowsAudioDevices(): Promise<string[]> {
    if (process.platform !== 'win32') return []
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
            stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        proc.stderr?.on('data', (chunk: Buffer | string) => {
            stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        })
        proc.on('close', () => {
            const devices: string[] = []
            let inAudio = false
            for (const line of stderr.split('\n')) {
                if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue }
                if (/DirectShow video devices/i.test(line)) { inAudio = false; continue }
                if (inAudio) {
                    const m = line.match(/"(.+?)"\s*$/)
                    if (m && !/Alternative name/i.test(line)) devices.push(m[1])
                }
            }
            resolve(devices)
        })
        proc.on('error', () => resolve([]))
    })
}

/**
 * Discover available audio input devices on macOS using FFmpeg avfoundation.
 * Returns a list of { index, name } objects for audio devices.
 */
export async function discoverMacAudioDevices(): Promise<{ index: number; name: string }[]> {
    if (process.platform !== 'darwin') return []
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
            stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        proc.stderr?.on('data', (chunk: Buffer | string) => {
            stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        })
        proc.on('close', () => {
            const devices: { index: number; name: string }[] = []
            let inAudio = false
            for (const line of stderr.split('\n')) {
                if (/AVFoundation audio devices:/i.test(line)) { inAudio = true; continue }
                if (/AVFoundation video devices:/i.test(line)) { inAudio = false; continue }
                if (inAudio) {
                    const m = line.match(/\[(\d+)]\s+(.+)/)
                    if (m) devices.push({ index: parseInt(m[1], 10), name: m[2].trim() })
                }
            }
            resolve(devices)
        })
        proc.on('error', () => resolve([]))
    })
}

/**
 * Discover available audio input devices on Linux.
 * Tries PulseAudio `pactl` first, falls back to ALSA `arecord`.
 * Returns a list of device identifiers.
 */
export async function discoverLinuxAudioDevices(): Promise<{ id: string; name: string }[]> {
    if (process.platform !== 'linux') return []

    // Try PulseAudio sources
    const pulseDevices = await new Promise<{ id: string; name: string }[]>((resolve) => {
        const proc = spawn('pactl', ['list', 'sources', 'short'], { stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        proc.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        })
        proc.on('close', () => {
            const devices: { id: string; name: string }[] = []
            for (const line of stdout.split('\n')) {
                const parts = line.trim().split('\t')
                if (parts.length >= 2 && parts[1]) {
                    devices.push({ id: parts[1], name: parts[1] })
                }
            }
            resolve(devices)
        })
        proc.on('error', () => resolve([]))
    })
    if (pulseDevices.length > 0) return pulseDevices

    // Fallback to ALSA
    return new Promise((resolve) => {
        const proc = spawn('arecord', ['-l'], { stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        proc.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        })
        proc.on('close', () => {
            const devices: { id: string; name: string }[] = []
            for (const line of stdout.split('\n')) {
                const m = line.match(/^card\s+(\d+):\s+(.+?),\s+device\s+(\d+):\s+(.+?)$/)
                if (m) {
                    devices.push({ id: `hw:${m[1]},${m[3]}`, name: `${m[2].trim()} - ${m[4].trim()}` })
                }
            }
            resolve(devices)
        })
        proc.on('error', () => resolve([]))
    })
}

/**
 * Show a QuickPick to select an audio input device for the current OS.
 * Saves the selection to the appropriate setting.
 */
export async function selectInputDevice(): Promise<void> {
    const items: vscode.QuickPickItem[] = [{ label: '$(sync) Auto-detect (default)', description: 'Let the extension auto-detect the device' }]

    if (process.platform === 'win32') {
        const devices = await discoverWindowsAudioDevices()
        items.push(...devices.map((d) => ({ label: d, description: 'DirectShow' })))
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select Windows audio input device' })
        if (!picked) return
        const value = picked.label.startsWith('$(sync)') ? '' : picked.label
        await getConfig().update('speechWindowsDevice', value, vscode.ConfigurationTarget.Global)
    } else if (process.platform === 'darwin') {
        const devices = await discoverMacAudioDevices()
        items.push(...devices.map((d) => ({ label: d.name, description: `AVFoundation index ${d.index}` })))
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select macOS audio input device' })
        if (!picked) return
        if (picked.label.startsWith('$(sync)')) {
            await getConfig().update('speechMacDevice', '', vscode.ConfigurationTarget.Global)
        } else {
            const dev = devices.find((d) => d.name === picked.label)
            await getConfig().update('speechMacDevice', dev ? `:${dev.index}` : '', vscode.ConfigurationTarget.Global)
        }
    } else {
        const devices = await discoverLinuxAudioDevices()
        items.push(...devices.map((d) => ({ label: d.name, description: d.id })))
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select Linux audio input device' })
        if (!picked) return
        if (picked.label.startsWith('$(sync)')) {
            await getConfig().update('speechLinuxInputDevice', 'default', vscode.ConfigurationTarget.Global)
        } else {
            const dev = devices.find((d) => d.name === picked.label)
            await getConfig().update('speechLinuxInputDevice', dev?.id ?? picked.label, vscode.ConfigurationTarget.Global)
        }
    }
    vscode.window.showInformationMessage('Speech input device updated.')
}