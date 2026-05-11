import type { AppConfig, Network } from './config.js'
import { buildPaymentRequest, type PaymentRequest } from './hashpaylink.js'

export type CommandResult = {
  text: string
}

const requests = new Map<string, PaymentRequest>()

function parseNetwork(raw: string | undefined, fallback: Network): Network {
  const value = (raw ?? '').toLowerCase()
  if (value === 'base' || value === 'arbitrum' || value === 'solana') return value
  return fallback
}

type ParsedRequestArgs =
  | { amount: string; memo: string; network: Network }
  | { error: string }

function parseRequestArgs(text: string, fallbackNetwork: Network): ParsedRequestArgs {
  const parts = text.trim().split(/\s+/)
  const rawAmount = parts[1]
  if (!rawAmount || Number.isNaN(Number(rawAmount)) || Number(rawAmount) <= 0) {
    return { error: 'Use /request 10 USDC for design work' }
  }
  const amount = rawAmount

  let network = fallbackNetwork
  const networkFlagIndex = parts.findIndex(part => part.startsWith('network=') || part.startsWith('net='))
  if (networkFlagIndex >= 0) {
    network = parseNetwork(parts[networkFlagIndex].split('=')[1], fallbackNetwork)
    parts.splice(networkFlagIndex, 1)
  }

  const memoStart = parts[2]?.toLowerCase() === 'usdc' ? 3 : 2
  const memo = parts.slice(memoStart).join(' ').replace(/^for\s+/i, '').trim() || 'Payment request'
  return { amount, memo, network }
}

function formatRequest(request: PaymentRequest) {
  return [
    'Hash PayLink created',
    '',
    `${request.amount} USDC`,
    request.memo,
    `Network: ${request.network}`,
    '',
    `Pay: ${request.payUrl}`,
    '',
    `Track: ${request.dashboardUrl}`,
  ].join('\n')
}

export function handleCommand(text: string, config: AppConfig): CommandResult {
  const trimmed = text.trim()

  if (trimmed === '/start' || trimmed === '/help') {
    return {
      text: [
        'Hash PayLink Agent',
        '',
        'Create USDC payment links from chat.',
        '',
        'Commands:',
        '/request 10 USDC for design work',
        '/request 25 USDC for event ticket net=solana',
        '/status <request-id>',
      ].join('\n'),
    }
  }

  if (trimmed.startsWith('/request')) {
    const parsed = parseRequestArgs(trimmed, config.defaultNetwork)
    if ('error' in parsed) return { text: parsed.error }

    const network = parsed.network
    const needsSolana = network === 'solana'
    const recipientReady = needsSolana ? !!config.defaultSolanaAddress : !!config.defaultEvmAddress
    if (!recipientReady) {
      return { text: `Missing default ${needsSolana ? 'Solana' : 'EVM'} recipient address. Add it to the bot environment first.` }
    }

    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.amount,
      memo: parsed.memo,
      network,
      evmAddress: config.defaultEvmAddress,
      solanaAddress: config.defaultSolanaAddress,
    })
    requests.set(request.id, request)
    return { text: formatRequest(request) }
  }

  if (trimmed.startsWith('/status')) {
    const id = trimmed.split(/\s+/)[1]
    if (!id) return { text: 'Use /status <request-id>' }
    const request = requests.get(id)
    if (!request) return { text: 'Request not found in this bot session. Open the dashboard link to track older requests.' }
    return {
      text: [
        'Payment request',
        '',
        `Amount: ${request.amount} USDC`,
        `Memo: ${request.memo}`,
        `Network: ${request.network}`,
        '',
        `Track: ${request.dashboardUrl}`,
      ].join('\n'),
    }
  }

  return { text: 'Unknown command. Use /help.' }
}
