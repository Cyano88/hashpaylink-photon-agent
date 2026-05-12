import type { AppConfig } from './config.js'
import { handleCommand, type CommandResult } from './commands.js'
import type { ProfileStore } from './store.js'

type TelegramUpdate = {
  update_id: number
  message?: {
    chat: { id: number }
    from?: { id: number }
    text?: string
  }
}

type TelegramResponse<T> = {
  ok: boolean
  result: T
  description?: string
}

export async function runTelegramBot(config: AppConfig, store: ProfileStore) {
  let offset = 0
  const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`

  async function callTelegram<T>(method: string, body: Record<string, unknown>) {
    const res = await fetch(`${apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as TelegramResponse<T>
    if (!data.ok) throw new Error(data.description ?? `Telegram ${method} failed`)
    return data.result
  }

  async function sendMessage(chatId: number, result: CommandResult) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: result.text,
      disable_web_page_preview: true,
    }
    if (result.buttons?.length) {
      body.reply_markup = {
        inline_keyboard: [result.buttons.map(button => ({
          text: button.text,
          url: button.url,
        }))],
      }
    }
    await callTelegram('sendMessage', body)
  }

  console.log('Hash PayLink Photon Agent listening for Telegram messages')

  while (true) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      })

      for (const update of updates) {
        offset = update.update_id + 1
        const chatId = update.message?.chat.id
        const userId = update.message?.from?.id
        const text = update.message?.text
        if (!chatId || !userId || !text) continue
        const result = await handleCommand(text, config, { userId: String(userId), store })
        await sendMessage(chatId, result)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}
