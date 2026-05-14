import type { AppConfig } from './config.js'
import { handleCommand, type CommandResult } from './commands.js'
import type { ProfileStore } from './store.js'

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    from?: { id: number }
    text?: string
    reply_to_message?: {
      text?: string
    }
  }
}

type TelegramResponse<T> = {
  ok: boolean
  result: T
  description?: string
}

type TelegramMessage = {
  message_id: number
}

export async function runTelegramBot(config: AppConfig, store: ProfileStore) {
  if (!config.telegramEnabled) {
    console.log('Telegram polling disabled.')
    return
  }
  if (!config.telegramBotToken) {
    console.warn('Telegram polling disabled: missing TELEGRAM_BOT_TOKEN.')
    return
  }

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
    } else if (result.forceReplyPlaceholder) {
      body.reply_markup = {
        force_reply: true,
        selective: true,
        input_field_placeholder: result.forceReplyPlaceholder,
      }
    } else if (result.buttonRows?.length) {
      body.reply_markup = {
        inline_keyboard: result.buttonRows.map(row => row.map(button => ({
          text: button.text,
          url: button.url,
        }))),
      }
    }
    return callTelegram<TelegramMessage>('sendMessage', body)
  }

  async function deleteMessage(chatId: number, messageId: number) {
    try {
      await callTelegram('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      })
      return true
    } catch {
      return false
    }
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
        const message = update.message
        const chatId = message?.chat.id
        const userId = message?.from?.id
        const text = message?.text
        if (!chatId || !userId || !text) continue

        if (text.trim() === '/clear') {
          const tracked = await store.clearBotMessages(String(userId), String(chatId))
          const deleted = (await Promise.all(tracked.map(messageId => deleteMessage(chatId, messageId))))
            .filter(Boolean).length
          await deleteMessage(chatId, message.message_id)
          const confirmation = await sendMessage(chatId, {
            text: deleted > 0
              ? `Cleared ${deleted} recent Hash PayLink bot message${deleted === 1 ? '' : 's'}.`
              : 'No recent Hash PayLink bot messages found to clear.',
          })
          setTimeout(() => {
            void deleteMessage(chatId, confirmation.message_id)
          }, 5_000)
          continue
        }

        const result = await handleCommand(text, config, {
          userId: String(userId),
          store,
          replyToText: message.reply_to_message?.text,
        })
        const sent = await sendMessage(chatId, result)
        await store.addBotMessage(String(userId), String(chatId), sent.message_id)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}
