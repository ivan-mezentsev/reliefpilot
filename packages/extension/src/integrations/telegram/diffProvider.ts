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
  }

  if (lines.length === 0) {
    return 'Changes detected in the active workspace.'
  }

  return lines.join('\n')
}

function sanitizeWorkspaceName(workspacePath: string): string {
  const base = path.basename(workspacePath).trim()
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return sanitized || 'workspace'
}

function createDiffFingerprint(patch: string): string {
  return createHash('sha256').update(patch, 'utf8').digest('hex')
}