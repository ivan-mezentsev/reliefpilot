import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DiffSnapshot {
  diffId: string
  sessionId: string
  source: 'git-worktree' | 'unavailable'
  summary: string
  fullArtifactPath: string | null
  fingerprint: string | null
  createdAt: Date
  status: 'ready' | 'unavailable' | 'stale'
}

export class DiffProvider {
  public async captureLatestDiff(sessionId: string, workspacePath: string | null): Promise<DiffSnapshot> {
    if (!workspacePath) {
      return this.createUnavailableSnapshot(sessionId, 'Diff unavailable: no active workspace is associated with this remote session.')
    }

    try {
      await this.runGit(workspacePath, ['rev-parse', '--show-toplevel'])
    } catch {
      return this.createUnavailableSnapshot(sessionId, 'Diff unavailable: the active workspace is not backed by git.')
    }

    try {
      const [patch, shortStat, nameOnly] = await Promise.all([
        this.runGit(workspacePath, ['diff', '--no-ext-diff', '--patch', '--binary', '--no-color']),
        this.runGit(workspacePath, ['diff', '--shortstat']).catch(() => ''),
        this.runGit(workspacePath, ['diff', '--name-only']).catch(() => ''),
      ])

      if (!patch.trim()) {
        return {
          diffId: randomUUID(),
          sessionId,
          source: 'git-worktree',
          summary: 'No local git diff is currently available for the active workspace.',
          fullArtifactPath: null,
          fingerprint: null,
          createdAt: new Date(),
          status: 'ready',
        }
      }

      const fullArtifactPath = await this.writeDiffArtifact(workspacePath, patch)

      return {
        diffId: randomUUID(),
        sessionId,
        source: 'git-worktree',
        summary: summarizeGitDiff(shortStat, nameOnly),
        fullArtifactPath,
        fingerprint: createDiffFingerprint(patch),
        createdAt: new Date(),
        status: 'ready',
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.createUnavailableSnapshot(sessionId, `Diff unavailable: ${message}`)
    }
  }

  private async runGit(workspacePath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    })

    return stdout.trim()
  }

  private async writeDiffArtifact(workspacePath: string, patch: string): Promise<string> {
    const workspaceName = sanitizeWorkspaceName(workspacePath)
    const stageDir = path.join(os.tmpdir(), 'reliefpilot-telegram-media', workspaceName, 'diffs')
    await fs.mkdir(stageDir, { recursive: true })

    const filePath = path.join(stageDir, `${randomUUID()}.patch`)
    await fs.writeFile(filePath, patch, 'utf8')
    return filePath
  }

  private createUnavailableSnapshot(sessionId: string, summary: string): DiffSnapshot {
    return {
      diffId: randomUUID(),
      sessionId,
      source: 'unavailable',
      summary,
      fullArtifactPath: null,
      fingerprint: null,
      createdAt: new Date(),
      status: 'unavailable',
    }
  }
}

export function summarizeGitDiff(shortStat: string, nameOnly: string): string {
  const lines: string[] = []
  const normalizedStat = shortStat.trim()
  if (normalizedStat) {
    lines.push(normalizedStat)
  }

  const files = nameOnly
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)

  if (files.length > 0) {
    const visibleFiles = files.slice(0, 3).map((fileName) => path.basename(fileName))
    const suffix = files.length > visibleFiles.length ? ` +${files.length - visibleFiles.length} more` : ''
    lines.push(`Files: ${visibleFiles.join(', ')}${suffix}`)
    lines.push(`Impact: ${buildDiffImpactSummary(files)}`)
  }

  if (lines.length === 0) {
    return 'Changes detected in the active workspace.'
  }

  return lines.join('\n')
}

function buildDiffImpactSummary(files: string[]): string {
  const categories = new Set(files.map(classifyChangedFile))

  if (categories.size === 1) {
    const [category] = [...categories]
    switch (category) {
      case 'docs':
        return 'Documentation-focused changes; behavior is unlikely to change directly.'
      case 'tests':
        return 'Test-only changes; likely validation or coverage updates.'
      case 'config':
        return 'Configuration/tooling changes; build or runtime setup may be affected.'
      case 'source':
      default:
        return 'Application code changed; behavior, APIs, or user-visible flow may be affected.'
    }
  }

  if (categories.has('source') && categories.has('tests')) {
    return 'Source code and tests changed together; behavior likely shifted with matching coverage updates.'
  }

  if (categories.has('source') && categories.has('config')) {
    return 'Source code and configuration changed together; behavior and setup may both be affected.'
  }

  if (categories.has('docs') && categories.size === 2 && categories.has('source')) {
    return 'Code and documentation changed together; implementation likely changed and docs were updated to match.'
  }

  if (categories.has('docs') && categories.size === 2 && categories.has('tests')) {
    return 'Tests and documentation changed together; validation or guidance may have been refined.'
  }

  return 'Changes span multiple areas of the workspace; review the full patch for scope and downstream impact.'
}

function classifyChangedFile(filePath: string): 'docs' | 'tests' | 'config' | 'source' {
  const normalized = filePath.trim().toLowerCase()
  const baseName = path.basename(normalized)

  if (
    normalized.includes('/docs/')
    || baseName.endsWith('.md')
    || baseName.endsWith('.mdx')
    || baseName === 'readme'
    || baseName.startsWith('readme.')
  ) {
    return 'docs'
  }

  if (
    normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('.test.')
    || normalized.includes('.spec.')
  ) {
    return 'tests'
  }

  if (
    baseName === 'package.json'
    || baseName.endsWith('.json')
    || baseName.endsWith('.yaml')
    || baseName.endsWith('.yml')
    || baseName.endsWith('.toml')
    || baseName.endsWith('.ini')
    || baseName.endsWith('.env')
    || normalized.includes('config')
    || normalized.includes('webpack')
    || normalized.includes('tsconfig')
  ) {
    return 'config'
  }

  return 'source'
}

function sanitizeWorkspaceName(workspacePath: string): string {
  const base = path.basename(workspacePath).trim()
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return sanitized || 'workspace'
}

function createDiffFingerprint(patch: string): string {
  return createHash('sha256').update(patch, 'utf8').digest('hex')
}