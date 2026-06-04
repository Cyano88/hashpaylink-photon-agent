import type { AppConfig } from './config.js'
import type { ProfileStore } from './store.js'

type TelegramButton = {
  text: string
  url: string
}

type TelegramOutbound = {
  text: string
  buttons?: TelegramButton[]
  buttonRows?: TelegramButton[][]
  forceReplyPlaceholder?: string
}

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    from?: {
      id: number
      username?: string
      first_name?: string
    }
    text?: string
    reply_to_message?: {
      text?: string
    }
  }
  inline_query?: TelegramInlineQuery
}

type TelegramInlineQuery = {
  id: string
  from?: {
    id: number
    username?: string
    first_name?: string
  }
  query?: string
  chat_type?: 'sender' | 'private' | 'group' | 'supergroup' | 'channel'
}

type TelegramResponse<T> = {
  ok: boolean
  result: T
  description?: string
}

type TelegramMessage = {
  message_id: number
}

type TelegramInlineResultArticle = {
  type: 'article'
  id: string
  title: string
  description: string
  input_message_content: {
    message_text: string
    disable_web_page_preview: boolean
  }
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>
  }
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

  function buildPaymentLinksUrl(options: { mode?: 'group' | 'person'; target?: string; username?: string } = {}) {
    const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
    const params = new URLSearchParams({ open: '1' })
    if (options.mode) params.set('mode', options.mode)
    if (options.target) params.set('target', options.target)
    if (options.username) params.set('u', options.username)
    return `${base}/telegram/payment-links?${params.toString()}`
  }

  function buildDashboardLauncher(username?: string): TelegramOutbound {
    return {
      text: [
        'Hash PayLink',
        '',
        'Create payment links, manage agent wallets, market tools, and StreamPay from the web dashboard.',
      ].join('\n'),
      buttons: [{ text: 'Open Hash PayLink', url: buildPaymentLinksUrl({ username }) }],
    }
  }

  async function sendMessage(chatId: number, result: TelegramOutbound) {
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

  function cleanInlineValue(value: string | undefined) {
    return (value ?? '').replace(/^@+/, '').trim()
  }

  function buildInlinePaymentLinksUrl(query: TelegramInlineQuery) {
    const isGroup = query.chat_type === 'group' || query.chat_type === 'supergroup' || query.chat_type === 'channel'
    const typedQuery = cleanInlineValue(query.query)
    const username = query.from?.username ?? query.from?.first_name

    if (isGroup) {
      return buildPaymentLinksUrl({ mode: 'group', target: typedQuery || undefined, username })
    }

    return buildPaymentLinksUrl({ mode: 'person', target: typedQuery || undefined, username })
  }

  async function answerInlineQuery(query: TelegramInlineQuery) {
    const url = buildInlinePaymentLinksUrl(query)
    const results: TelegramInlineResultArticle[] = [{
      type: 'article',
      id: 'hashpaylink-payment-links',
      title: 'Create a Hash PayLink',
      description: 'Open the Telegram payment dashboard',
      input_message_content: {
        message_text: 'Hash PayLink for Telegram\n\nOpen the dashboard to create payment links and share them back into this chat.',
        disable_web_page_preview: true,
      },
      reply_markup: {
        inline_keyboard: [[{ text: 'Open Hash PayLink', url }]],
      },
    }]

    await callTelegram<boolean>('answerInlineQuery', {
      inline_query_id: query.id,
      results,
      cache_time: 1,
      is_personal: true,
    })
  }

  console.log('Hash PayLink Photon Agent listening for Telegram messages')

  while (true) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'inline_query'],
      })

      for (const update of updates) {
        offset = update.update_id + 1
        if (update.inline_query) {
          await answerInlineQuery(update.inline_query)
          continue
        }

        const message = update.message
        const chatId = message?.chat.id
        const userId = message?.from?.id
        const text = message?.text
        if (!chatId || !userId || !text) continue

        const username = message.from?.username ?? message.from?.first_name
        const sent = await sendMessage(chatId, buildDashboardLauncher(username))
        await store.addBotMessage(String(userId), String(chatId), sent.message_id)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}
