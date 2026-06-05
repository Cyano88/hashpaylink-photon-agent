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
    chat: {
      id: number
      type?: 'private' | 'group' | 'supergroup' | 'channel'
    }
    from?: {
      id: number
      username?: string
      first_name?: string
    }
    via_bot?: {
      id: number
      username?: string
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

const DASHBOARD_MESSAGE = [
  'Hash PayLink',
  '',
  'Open the dashboard to create payment links and share them back into Telegram.',
].join('\n')

type TelegramSavedRequest = {
  id: string
  mode: 'person' | 'group'
  wallet: string
  network: 'base' | 'solana'
  label: string
  amount: string
  target: string
  payUrl: string
  createdAt: number
}

type TelegramRequestResponse = {
  ok: boolean
  request?: TelegramSavedRequest
  error?: string
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await res.json() as TelegramResponse<T>
      if (!data.ok) throw new Error(data.description ?? `Telegram ${method} failed`)
      return data.result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Telegram ${method} failed: ${message}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  function dashboardBaseUrl() {
    const configured = config.hashPayLinkBaseUrl.trim().replace(/\/+$/, '')
    if (!configured) return 'https://hashpaylink.com'
    return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`
  }

  function buildPaymentLinksUrl(options: { mode?: 'group' | 'person'; target?: string; username?: string } = {}) {
    const base = dashboardBaseUrl()
    const params = new URLSearchParams({ open: '1' })
    if (options.mode) params.set('mode', options.mode)
    if (options.target) params.set('target', options.target)
    if (options.username) params.set('u', options.username)
    return `${base}/telegram/payment-links?${params.toString()}`
  }

  function buildDashboardLauncher(username?: string, withButton = true): TelegramOutbound {
    const url = buildPaymentLinksUrl({ username })
    const text = [
      DASHBOARD_MESSAGE,
      ...(withButton ? [] : ['', url]),
    ].join('\n')

    return {
      text,
      buttons: withButton ? [{ text: 'Open Hash PayLink', url }] : undefined,
    }
  }

  function buildTelegramRequestUrl(id: string) {
    const base = dashboardBaseUrl()
    const params = new URLSearchParams({ id })
    return `${base}/api/telegram-request?${params.toString()}`
  }

  async function fetchTelegramRequest(id: string) {
    const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!cleanId) throw new Error('Missing Telegram request id')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const res = await fetch(buildTelegramRequestUrl(cleanId), { signal: controller.signal })
      const data = await res.json() as TelegramRequestResponse
      if (!res.ok || !data.ok || !data.request) {
        throw new Error(data.error ?? `Request lookup failed with HTTP ${res.status}`)
      }
      return data.request
    } finally {
      clearTimeout(timeout)
    }
  }

  function buildSavedRequestMessage(request: TelegramSavedRequest): TelegramOutbound {
    const amountLine = request.amount ? `${request.amount} USDC` : 'USDC'
    const payLabel = request.amount ? `Pay ${request.amount} USDC` : 'Open payment link'
    const targetLine = request.mode === 'group'
      ? `Group: ${request.target}`
      : `Payer: ${request.target}`
    const actionLine = request.mode === 'group'
      ? `${request.label} is collecting ${amountLine}.`
      : `${request.label} requested ${amountLine}.`

    return {
      text: [
        request.mode === 'group' ? 'Hash PayLink collection' : 'Hash PayLink payment request',
        '',
        actionLine,
        targetLine,
        '',
        'Verify before paying.',
      ].join('\n'),
      buttons: [{ text: payLabel, url: request.payUrl }],
    }
  }

  async function sendSavedPaymentRequest(chatId: number, requestId: string) {
    const request = await fetchTelegramRequest(requestId)
    return sendMessage(chatId, buildSavedRequestMessage(request))
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

  async function sendDashboardLauncher(chatId: number, username?: string) {
    try {
      return await sendMessage(chatId, buildDashboardLauncher(username))
    } catch (err) {
      console.error(`Telegram dashboard button failed: ${err instanceof Error ? err.message : err}`)
      return sendMessage(chatId, buildDashboardLauncher(username, false))
    }
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
        message_text: DASHBOARD_MESSAGE,
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
        if (message.via_bot) continue

        const parts = text.trim().split(/\s+/)
        const command = parts[0]?.toLowerCase().replace(/@\w+$/, '') ?? ''
        if (command !== '/start' && command !== '/hashpay') continue

        const username = message.from?.username ?? message.from?.first_name
        console.log(`Telegram message received: chat=${message.chat.type ?? 'unknown'} command=${command}`)
        if (command === '/start' && parts[1]?.startsWith('share_')) {
          const requestId = parts[1].replace(/^share_/, '')
          const sent = await sendSavedPaymentRequest(chatId, requestId)
          console.log(`Telegram payment request sent: chat=${message.chat.type ?? 'unknown'} message=${sent.message_id}`)
          await store.addBotMessage(String(userId), String(chatId), sent.message_id)
          continue
        }

        const sent = await sendDashboardLauncher(chatId, username)
        console.log(`Telegram dashboard reply sent: chat=${message.chat.type ?? 'unknown'} message=${sent.message_id}`)
        await store.addBotMessage(String(userId), String(chatId), sent.message_id)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}
