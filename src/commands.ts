import type { AppConfig, Network } from './config.js'
import { buildPaymentRequest, type PaymentRequest } from './hashpaylink.js'
import type { ProfileStore, UserProfile } from './store.js'

export type CommandResult = {
  text: string
}

export type CommandContext = {
  userId: string
  store: ProfileStore
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

function shortAddress(value: string | undefined) {
  if (!value) return 'not set'
  if (value.length <= 14) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function isEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

function isLikelySolanaAddress(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
}

function userNetwork(profile: UserProfile, config: AppConfig): Network {
  return profile.defaultNetwork ?? config.defaultNetwork
}

export async function handleCommand(text: string, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const trimmed = text.trim()
  const profile = context.store.getUser(context.userId)

  if (trimmed === '/start' || trimmed === '/help') {
    return {
      text: [
        'Hash PayLink Agent',
        '',
        'Create USDC payment links from chat.',
        '',
        'Commands:',
        '/setevm 0xYourAddress',
        '/setsol YourSolanaAddress',
        '/network base',
        '/request 10 USDC for design work',
        '/request 25 USDC for event ticket net=solana',
        '/me',
        '/status <request-id>',
      ].join('\n'),
    }
  }

  if (trimmed.startsWith('/setevm')) {
    const address = trimmed.split(/\s+/)[1]
    if (!address || !isEvmAddress(address)) return { text: 'Use /setevm 0xYourEvmAddress' }
    await context.store.updateUser(context.userId, { evmAddress: address })
    return { text: `EVM recipient saved: ${shortAddress(address)}` }
  }

  if (trimmed.startsWith('/setsol')) {
    const address = trimmed.split(/\s+/)[1]
    if (!address || !isLikelySolanaAddress(address)) return { text: 'Use /setsol YourSolanaAddress' }
    await context.store.updateUser(context.userId, { solanaAddress: address })
    return { text: `Solana recipient saved: ${shortAddress(address)}` }
  }

  if (trimmed.startsWith('/network')) {
    const nextNetwork = parseNetwork(trimmed.split(/\s+/)[1], userNetwork(profile, config))
    await context.store.updateUser(context.userId, { defaultNetwork: nextNetwork })
    return { text: `Default network saved: ${nextNetwork}` }
  }

  if (trimmed === '/me') {
    return {
      text: [
        'Your Hash PayLink settings',
        '',
        `EVM: ${shortAddress(profile.evmAddress)}`,
        `Solana: ${shortAddress(profile.solanaAddress)}`,
        `Default network: ${userNetwork(profile, config)}`,
      ].join('\n'),
    }
  }

  if (trimmed.startsWith('/request')) {
    const parsed = parseRequestArgs(trimmed, userNetwork(profile, config))
    if ('error' in parsed) return { text: parsed.error }

    const network = parsed.network
    const needsSolana = network === 'solana'
    const evmAddress = profile.evmAddress ?? config.defaultEvmAddress
    const solanaAddress = profile.solanaAddress ?? config.defaultSolanaAddress
    const recipientReady = needsSolana ? !!solanaAddress : !!evmAddress
    if (!recipientReady) {
      return { text: `Set your ${needsSolana ? 'Solana' : 'EVM'} recipient first with /set${needsSolana ? 'sol' : 'evm'}.` }
    }

    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.amount,
      memo: parsed.memo,
      network,
      evmAddress,
      solanaAddress,
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
