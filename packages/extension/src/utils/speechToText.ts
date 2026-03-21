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
    responseFormat: string
}

interface WindowsAudioDeviceDiscoveryResult {
    devices: string[]
    ffmpegMissing: boolean
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
    const responseFormat = (config.get<string>('speechResponseFormat', 'json') ?? 'json').trim() || 'json'
    return { apiKey, endpointBase, model, language, responseFormat }
}

const FFMPEG_INSTALL_URL = 'https://ffmpeg.org/download.html'

async function promptToInstallFfmpeg(): Promise<boolean> {
    const message = 'FFmpeg is not found on your system. Please install it and press OK to retry. Installation guide: ' + FFMPEG_INSTALL_URL
    while (true) {
        const selection = await vscode.window.showInformationMessage(
            message,
            { modal: true, detail: 'FFmpeg is required for microphone capture in Relief Pilot voice input.' },
            'Open installation guide',
            'OK',
        )

        if (selection === 'Open installation guide') {
            await vscode.env.openExternal(vscode.Uri.parse(FFMPEG_INSTALL_URL))
            continue
        }
        if (selection === 'OK') return true
        return false
    }
}

function isFfmpegMissingError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const code = (err as Error & { code?: unknown }).code
    return code === 'ENOENT' || /ENOENT/i.test(err.message) || /spawn\s+ffmpeg\s+ENOENT/i.test(err.message)
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

function buildStreamingFfmpegArgs(opts: { outputPattern: string; chunkSeconds: number; linuxBackend?: LinuxInputBackend; windowsDevice?: string; macDevice?: string }): string[] {
    const common = ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le']
    const segment = [
        '-f', 'segment',
        '-segment_time', String(opts.chunkSeconds),
        '-segment_format', 'wav',
        '-reset_timestamps', '1',
        '-segment_start_number', '0',
        opts.outputPattern,
    ]

    if (process.platform === 'linux') {
        const backend = opts.linuxBackend ?? 'pulse'
        return ['-f', backend, '-i', getLinuxDevice(), ...common, ...segment]
    }
    if (process.platform === 'darwin') {
        const dev = opts.macDevice || ':default'
        return ['-f', 'avfoundation', '-i', dev, ...common, ...segment]
    }
    const dev = opts.windowsDevice ?? 'default'
    return ['-f', 'dshow', '-i', `audio=${dev}`, ...common, ...segment]
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
 * Accepts an optional AbortSignal for session-level cancellation.
 */
export async function transcribeAudio(audioBuffer: Buffer, signal?: AbortSignal): Promise<string> {
    const { apiKey, endpointBase, model, language, responseFormat } = await getSpeechConfig()
    if (!endpointBase) {
        throw new Error('Speech transcription endpoint is not configured. Set "reliefpilot.speechTranscriptionEndpoint" in settings.')
    }

    const resp = await sendTranscriptionRequest(audioBuffer, { apiKey, endpointBase, model, language, responseFormat, signal })

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '')

        if (responseFormat === 'verbose_json' && errText.includes('response_format')) {
            throw new Error(
                `Speech transcription error ${resp.status}: endpoint rejected response_format="verbose_json". `
                + 'Set "reliefpilot.speechResponseFormat" to "json" for providers that do not support verbose_json.',
            )
        }

        throw new Error(`Speech transcription error ${resp.status}: ${errText}`)
    }

    return parseTranscriptionResponse(resp)
}

async function sendTranscriptionRequest(
    audioBuffer: Buffer,
    opts: { apiKey: string; endpointBase: string; model: string; language: string; responseFormat: string; signal?: AbortSignal },
): Promise<Response> {
    const boundary = '----ReliefPilotSpeech' + randomUUID()
    const parts: Buffer[] = []

    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ))
    parts.push(audioBuffer)
    parts.push(Buffer.from('\r\n'))
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${opts.model}\r\n`,
    ))
    if (opts.language) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${opts.language}\r\n`,
        ))
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\n${opts.responseFormat}\r\n`,
    ))
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)
    const headers: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }
    if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`
    }

    // Combine session abort signal with a per-request timeout
    const timeoutSignal = AbortSignal.timeout(30_000)
    const fetchSignal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal

    return fetch(`${opts.endpointBase}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body,
        signal: fetchSignal,
    })
}

async function parseTranscriptionResponse(resp: Response): Promise<string> {
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
async function transcribeAndEmit(
    buf: Buffer,
    onText: (text: string) => void,
    transcriber?: (buf: Buffer, signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
): Promise<void> {
    if (buf.length < 1000) return
    const text = (await (transcriber ?? transcribeAudio)(buf, signal)).trim()
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
    onCancel?: () => void
    onError: (err: Error) => void
    chunkSeconds?: number
    /** @internal test-only overrides */
    _test?: {
        spawnFfmpeg?: (args: string[]) => { proc: ChildProcess; getStderr: () => string }
        transcribeAudio?: (buf: Buffer, signal?: AbortSignal) => Promise<string>
        promptToInstallFfmpeg?: () => Promise<boolean>
        discoverWindowsAudioDevices?: () => Promise<WindowsAudioDeviceDiscoveryResult>
        platform?: NodeJS.Platform
    }
}): StreamingRecordingSession {
    const chunkSec = opts.chunkSeconds ?? 3
    const runtimePlatform = opts._test?.platform ?? process.platform
    let tmpDir: string | undefined
    let prefix: string | undefined
    let proc: ChildProcess | undefined
    let cancelled = false
    let stopping = false
    let linuxBackendIdx = 0
    let stderrGetter: (() => string) | undefined
    let processCloseResolver: (() => void) | undefined
    let resolvedWindowsDevice: string | undefined
    let resolvedMacDevice: string | undefined
    let ffmpegInstallRetried = false
    let ffmpegInstallPromptInProgress = false
    let pollTimer: NodeJS.Timeout | undefined
    let nextChunkIndex = 0
    let producedAnyChunk = false

    // Session-level abort controller — aborts all in-flight fetch requests
    const abortController = new AbortController()

    // Track in-flight transcription promises so stop() can drain them
    const inFlight = new Set<Promise<void>>()

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

    function ensureTempArtifacts() {
        if (tmpDir && prefix) return

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefpilot-stream-'))
        prefix = path.basename(tmpDir)
    }

    function getChunkFile(index: number) {
        if (!tmpDir || !prefix) {
            throw new Error('Streaming recording temp directory is not initialized.')
        }

        return path.join(tmpDir, `${prefix}-${String(index).padStart(6, '0')}.wav`)
    }

    function getOutputPattern() {
        if (!tmpDir || !prefix) {
            throw new Error('Streaming recording temp directory is not initialized.')
        }

        return path.join(tmpDir, `${prefix}-%06d.wav`)
    }

    function canFallbackLinuxBackend(): boolean {
        if (runtimePlatform !== 'linux' || stopping) return false
        const backends = getLinuxBackends()
        return backends.length > 1 && linuxBackendIdx + 1 < backends.length
    }

    function failRecording(err: Error) {
        if (cancelled) return
        cleanup()
        opts.onError(err)
    }

    function cancelBeforeStart() {
        cleanup()
        if (opts.onCancel) {
            opts.onCancel()
            return
        }

        opts.onEnd()
    }

    function retryAfterFfmpegInstall(onRetry: () => void | Promise<void>) {
        if (ffmpegInstallPromptInProgress) {
            return
        }

        if (ffmpegInstallRetried) {
            failRecording(new Error('FFmpeg is still not found after retry.'))
            return
        }

        ffmpegInstallPromptInProgress = true
        void (async () => {
            try {
                const retry = await (opts._test?.promptToInstallFfmpeg ?? promptToInstallFfmpeg)()
                ffmpegInstallPromptInProgress = false

                if (cancelled || stopping) return

                if (retry) {
                    ffmpegInstallRetried = true
                    await onRetry()
                    return
                }

                failRecording(new Error('FFmpeg is not installed. User cancelled.'))
            } catch (promptErr) {
                ffmpegInstallPromptInProgress = false
                failRecording(promptErr instanceof Error ? promptErr : new Error(String(promptErr)))
            }
        })()
    }

    function handleFfmpegSpawnError(err: Error) {
        if (cancelled) return

        if (!isFfmpegMissingError(err)) {
            failRecording(err)
            return
        }

        retryAfterFfmpegInstall(() => startContinuousRecording())
    }

    function queueChunkProcessing(filePath: string, chunkIndex: number) {
        producedAnyChunk = true
        const task = (async () => {
            try {
                const buf = fs.readFileSync(filePath)
                fs.unlinkSync(filePath)
                await transcribeAndEmit(buf, (text) => enqueueEmit(chunkIndex, text), opts._test?.transcribeAudio, abortController.signal)
                if (!pendingEmits.has(chunkIndex) && chunkIndex >= nextEmitIndex) {
                    enqueueEmit(chunkIndex, null)
                }
            } catch (err) {
                if (!stopping && !cancelled) {
                    failRecording(err instanceof Error ? err : new Error(String(err)))
                }
            }
        })()
        inFlight.add(task)
        void task.finally(() => inFlight.delete(task))
    }

    function flushReadyChunks(final = false) {
        while (true) {
            const current = getChunkFile(nextChunkIndex)
            if (!fs.existsSync(current)) {
                return
            }

            const next = getChunkFile(nextChunkIndex + 1)
            if (!final && !fs.existsSync(next)) {
                return
            }

            const chunkIndex = nextChunkIndex
            nextChunkIndex++
            queueChunkProcessing(current, chunkIndex)
        }
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = undefined
        }
    }

    function startPolling() {
        stopPolling()
        pollTimer = setInterval(() => {
            if (cancelled) return
            flushReadyChunks(false)
        }, 200)
    }

    function startContinuousRecording() {
        if (cancelled || stopping) return

        ensureTempArtifacts()

        const backends = getLinuxBackends()
        const linuxBackend = runtimePlatform === 'linux'
            ? (backends[linuxBackendIdx] ?? backends[0] ?? 'pulse')
            : undefined

        const ffmpegArgs = buildStreamingFfmpegArgs({ outputPattern: getOutputPattern(), chunkSeconds: chunkSec, linuxBackend, windowsDevice: resolvedWindowsDevice, macDevice: resolvedMacDevice })
        const started = (opts._test?.spawnFfmpeg ?? spawnFfmpeg)(ffmpegArgs)
        proc = started.proc
        stderrGetter = started.getStderr
        let skipCloseHandling = false

        startPolling()

        proc.on('close', () => {
            stopPolling()

            const finalizeClose = () => {
                if (skipCloseHandling) {
                    processCloseResolver?.()
                    processCloseResolver = undefined
                    return
                }

                if (cancelled) {
                    processCloseResolver?.()
                    processCloseResolver = undefined
                    return
                }

                flushReadyChunks(true)
                processCloseResolver?.()
                processCloseResolver = undefined

                if (stopping) {
                    return
                }

                if (!producedAnyChunk && canFallbackLinuxBackend()) {
                    linuxBackendIdx++
                    startContinuousRecording()
                    return
                }

                failRecording(new Error(`Microphone recording failed: ${describeFfmpegFailure(stderrGetter?.() ?? '')}`))
            }

            finalizeClose()
        })

        proc.on('error', (err) => {
            stopPolling()
            skipCloseHandling = true
            handleFfmpegSpawnError(err)
        })
    }

    function cleanup() {
        cancelled = true
        stopping = false
        abortController.abort()
        stopPolling()
        try { proc?.kill('SIGKILL') } catch { /* ignore */ }
        removeTempArtifacts()
    }

    function removeTempArtifacts() {
        if (!tmpDir) return

        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
            // ignore cleanup errors
        }

        tmpDir = undefined
        prefix = undefined
    }

    // Resolve platform-specific device once before starting chunks
    void (async () => {
        try {
            // Prompt for API key on first use (user can skip by leaving empty)
            if (!opts._test) {
                const proceed = await ensureSpeechApiKeyPrompted()
                if (!proceed) {
                    cancelBeforeStart()
                    return
                }
            }

            if (cancelled || stopping) return

            if (runtimePlatform === 'win32') {
                const configured = getWindowsDevice()
                if (configured) {
                    resolvedWindowsDevice = configured
                } else {
                    const discovery = await (opts._test?.discoverWindowsAudioDevices ?? discoverWindowsAudioDevicesDetailed)()
                    if (discovery.ffmpegMissing) {
                        retryAfterFfmpegInstall(async () => {
                            const retryDiscovery = await (opts._test?.discoverWindowsAudioDevices ?? discoverWindowsAudioDevicesDetailed)()
                            if (retryDiscovery.ffmpegMissing) {
                                failRecording(new Error('FFmpeg is still not found after retry.'))
                                return
                            }

                            resolvedWindowsDevice = retryDiscovery.devices[0]
                            if (!resolvedWindowsDevice) {
                                failRecording(new Error(
                                    'No DirectShow audio input device found. Install a microphone driver or set "reliefpilot.speechWindowsDevice" in settings.',
                                ))
                                return
                            }

                            startContinuousRecording()
                        })
                        return
                    }

                    resolvedWindowsDevice = discovery.devices[0]
                    if (!resolvedWindowsDevice) {
                        failRecording(new Error(
                            'No DirectShow audio input device found. Install a microphone driver or set "reliefpilot.speechWindowsDevice" in settings.',
                        ))
                        return
                    }
                }
            } else if (runtimePlatform === 'darwin') {
                const configured = getMacDevice()
                if (configured) {
                    resolvedMacDevice = configured
                } else {
                    const devices = await discoverMacAudioDevices()
                    resolvedMacDevice = devices.length > 0 ? `:${devices[0].index}` : undefined
                    // macOS falls back to :default if no device discovered
                }
            }

            if (cancelled || stopping) return
            startContinuousRecording()
        } catch (err) {
            failRecording(err instanceof Error ? err : new Error(String(err)))
        }
    })()

    return {
        stop() {
            if (cancelled || stopping) return
            stopping = true

            const waitForClose = new Promise<void>((resolve) => {
                processCloseResolver = resolve
                setTimeout(resolve, 2500)
            })
            try { proc?.kill('SIGINT') } catch { /* ignore */ }

            void (async () => {
                await waitForClose

                // Drain all in-flight transcription promises before signaling end.
                // Loop until the set is truly empty — a late close handler may
                // register one more task after the initial snapshot.
                while (inFlight.size > 0) {
                    await Promise.allSettled([...inFlight])
                }

                // Best-effort cleanup for the graceful stop path as well.
                // The recording process should already be closed here, but if it
                // outlived the wait window, terminate it before removing temp files.
                try { proc?.kill('SIGKILL') } catch { /* ignore */ }
                removeTempArtifacts()

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
async function discoverWindowsAudioDevicesDetailed(): Promise<WindowsAudioDeviceDiscoveryResult> {
    if (process.platform !== 'win32') {
        return { devices: [], ffmpegMissing: false }
    }
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
            resolve({ devices, ffmpegMissing: false })
        })
        proc.on('error', (err) => resolve({ devices: [], ffmpegMissing: isFfmpegMissingError(err) }))
    })
}

export async function discoverWindowsAudioDevices(): Promise<string[]> {
    const result = await discoverWindowsAudioDevicesDetailed()
    return result.devices
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