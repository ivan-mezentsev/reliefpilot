import type { Context, MiddlewareFn } from 'grammy'
import * as vscode from 'vscode'

export function createAuthMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId) {
      await ctx.reply('Unable to identify user.')
      return
    }

    if (!isAuthorized(userId)) {
      await ctx.reply('Unauthorized. Contact the bot owner.')
      return
    }

    await next()
  }
}

export function isAuthorized(userId: number): boolean {
  const config = vscode.workspace.getConfiguration('reliefpilot')
  const authorizedIds = config.get<number[]>('telegramAuthorizedUserIds', [])
  return authorizedIds.includes(userId)
}

export async function bindOwner(userId: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('reliefpilot')
  const authorizedIds = config.get<number[]>('telegramAuthorizedUserIds', [])

  if (!authorizedIds.includes(userId)) {
    await config.update('telegramAuthorizedUserIds', [...authorizedIds, userId], vscode.ConfigurationTarget.Global)
  }
}

export function hasOwner(): boolean {
  const config = vscode.workspace.getConfiguration('reliefpilot')
  const authorizedIds = config.get<number[]>('telegramAuthorizedUserIds', [])
  return authorizedIds.length > 0
}
