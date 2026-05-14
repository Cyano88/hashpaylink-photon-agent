import crypto from 'node:crypto'
import http from 'node:http'
import type { AppConfig } from './config.js'
import { handleCommand, type CommandResult } from './commands.js'
import type { ProfileStore } from './store.js'

type WhatsAppMessage = {
  from?: string
  id?: string
  type?: string
  text?: { body?: string }
}

type WhatsAppWebhook = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[]
      }
    }>
  }>
}

const PAYMENT_COMMANDS = new Set(['/request', '/status', '/requests', '/remind'])

function commandName(text: string) {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

function helpText() {
  return [
    'Hash PayLink on WhatsApp',
    '',
    'Create a payment request:',
    '/request 10 USDC for design work',
    '/request 25 USDC for event ticket net=solana',
    '',
    'Track payment requests:',
    '/requests',
    '/status <request-id>',
    '/remind <request-id>',
    '',
    'WhatsApp currently supports payment requests only.',
  ].join('\n')
}

function whatsappText(result: CommandResult) {
  const links = [
    ...(result.buttons ?? []),
    ...(result.buttonRows ?? []).flat(),
  ]
  if (!links.length) return result.text
  return [
    result.text,
    '',
    ...links.map(button => `${button.text}: ${button.url}`),
  ].join('\n')
}

function verifySignature(config: AppConfig, rawBody: string, signature: string | undefined) {
  if (!config.whatsappAppSecret) return true
  if (!signature?.startsWith('sha256=')) return false
  const expected = `sha256=${crypto
    .createHmac('sha256', config.whatsappAppSecret)
    .update(rawBody)
    .digest('hex')}`
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function extractMessages(payload: WhatsAppWebhook) {
  return (payload.entry ?? []).flatMap(entry =>
    (entry.changes ?? []).flatMap(change => change.value?.messages ?? []),
  )
}

async function sendWhatsAppText(config: AppConfig, to: string, text: string) {
  const res = await fetch(`https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        preview_url: true,
        body: text.slice(0, 3900),
      },
    }),
  })
  const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
  if (!res.ok) throw new Error(data.error?.message ?? `WhatsApp send failed: ${res.status}`)
}

async function handlePaymentMessage(message: WhatsAppMessage, config: AppConfig, store: ProfileStore) {
  const from = message.from
  const text = message.text?.body?.trim()
  if (!from || !text) return

  const cmd = commandName(text)
  if (cmd === '/start' || cmd === '/help' || cmd === 'help') {
    await sendWhatsAppText(config, from, helpText())
    return
  }

  if (!PAYMENT_COMMANDS.has(cmd)) {
    await sendWhatsAppText(config, from, 'WhatsApp currently supports Hash PayLink payment requests only. Use /help for examples.')
    return
  }

  if (cmd === '/request' && !config.defaultEvmAddress && !config.defaultSolanaAddress) {
    await sendWhatsAppText(config, from, 'WhatsApp payment requests need DEFAULT_EVM_ADDRESS or DEFAULT_SOLANA_ADDRESS configured on the agent.')
    return
  }

  const result = await handleCommand(text, config, {
    userId: `whatsapp:${from}`,
    store,
  })
  await sendWhatsAppText(config, from, whatsappText(result))
}

export function runWhatsAppPaymentBot(config: AppConfig, store: ProfileStore) {
  if (!config.whatsappEnabled) return
  if (!config.whatsappAccessToken || !config.whatsappPhoneNumberId || !config.whatsappVerifyToken) {
    console.warn('WhatsApp disabled: missing WHATSAPP_ACCESS_TOKEN/WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID/WA_NUMBER_ID, or WHATSAPP_VERIFY_TOKEN.')
    return
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (req.method === 'GET' && url.pathname === '/webhook/whatsapp') {
        const mode = url.searchParams.get('hub.mode')
        const token = url.searchParams.get('hub.verify_token')
        const challenge = url.searchParams.get('hub.challenge')
        if (mode === 'subscribe' && token === config.whatsappVerifyToken && challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(challenge)
          return
        }
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      if (req.method === 'POST' && url.pathname === '/webhook/whatsapp') {
        const rawBody = await readBody(req)
        if (!verifySignature(config, rawBody, req.headers['x-hub-signature-256'] as string | undefined)) {
          res.writeHead(403)
          res.end('Invalid signature')
          return
        }

        res.writeHead(200)
        res.end('OK')

        const payload = JSON.parse(rawBody) as WhatsAppWebhook
        for (const message of extractMessages(payload)) {
          if (message.type === 'text') {
            void handlePaymentMessage(message, config, store).catch(err => {
              console.error(err instanceof Error ? err.message : err)
            })
          }
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      res.writeHead(404)
      res.end('Not found')
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      if (!res.headersSent) res.writeHead(500)
      res.end('Internal Server Error')
    }
  })

  server.listen(config.whatsappPort, () => {
    console.log(`Hash PayLink WhatsApp payment webhook listening on port ${config.whatsappPort}`)
  })
}
