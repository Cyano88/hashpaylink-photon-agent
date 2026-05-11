import type { AppConfig } from './config.js'
import { handleCommand } from './commands.js'

type TelegramUpdate = {
  update_id: number
  message?: {
    chat: { id: number }
    text?: string
  }
}

type TelegramResponse<T> = {
  ok: boolean
  result: T
  description?: string
}

export async function runTelegramBot(config: AppConfig) {
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

  async function sendMessage(chatId: number, text: string) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    })
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
        const text = update.message?.text
        if (!chatId || !text) continue
        const result = handleCommand(text, config)
        await sendMessage(chatId, result.text)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}
