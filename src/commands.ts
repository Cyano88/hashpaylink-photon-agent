import type { AppConfig, Network } from './config.js'
import { buildPaymentRequest, type PaymentRequest } from './hashpaylink.js'
import type { ProfileStore, UserProfile } from './store.js'

export type CommandResult = {
  text: string
  buttons?: Array<{ text: string; url: string }>
  buttonRows?: Array<Array<{ text: string; url: string }>>
}

export type CommandContext = {
  userId: string
  store: ProfileStore
}

const requests = new Map<string, PaymentRequest>()
const latestRequestByUser = new Map<string, string>()
const FOOTER = 'Built for Photon - Powered by Hash PayLink'
const NETWORK_HELP = [
  'Supported networks',
  '',
  'base - Base USDC',
  'arbitrum - Arbitrum USDC',
  'solana - Solana USDC',
  '',
  'Set default:',
  '/network solana',
  '',
  'Override once:',
  '/request 10 USDC for design net=solana',
]

type RequestStats = {
  ok: boolean
  count: number
  collected: number
  archived: number
  error?: string
}

function withFooter(lines: string[]) {
  return [...lines, '', FOOTER].join('\n')
}

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
  return {
    text: withFooter([
      'Hash PayLink collection created',
      '',
      `${request.amount} USDC`,
      request.memo,
      `Network: ${request.network}`,
    ]),
    buttons: requestButtons(request),
  }
}

function requestButtons(request: PaymentRequest) {
  return [
    { text: 'Pay', url: request.payUrl },
    { text: 'Track', url: request.dashboardUrl },
  ]
}

function formatUsdc(value: number) {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: value > 0 && value < 1 ? 2 : 0,
    maximumFractionDigits: 6,
  })
}

async function fetchRequestStats(request: PaymentRequest, config: AppConfig): Promise<RequestStats> {
  try {
    const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
    const url = `${base}/api/list-event-payments?id=${encodeURIComponent(request.id)}`
    const response = await fetch(url)
    const data = await response.json() as {
      ok?: boolean
      error?: string
      payments?: Array<{ amount?: string; ogTxHash?: string }>
    }
    if (!response.ok || !data.ok) throw new Error(data.error ?? 'Status unavailable')
    const payments = data.payments ?? []
    return {
      ok: true,
      count: payments.length,
      collected: payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0),
      archived: payments.filter(payment => !!payment.ogTxHash).length,
    }
  } catch (err) {
    return {
      ok: false,
      count: 0,
      collected: 0,
      archived: 0,
      error: 'Try again shortly.',
    }
  }
}

function progressLines(stats: RequestStats) {
  if (!stats.ok) return ['Live status: unavailable', stats.error ?? 'Try again shortly.']
  if (stats.count === 0) return ['Live status: no payments yet']
  return [
    `Live status: ${stats.count} payment${stats.count === 1 ? '' : 's'} received`,
    `Collected: ${formatUsdc(stats.collected)} USDC`,
    `0G archive: ${stats.archived}/${stats.count}`,
  ]
}

async function formatStatus(request: PaymentRequest, config: AppConfig) {
  const stats = await fetchRequestStats(request, config)
  return {
    text: withFooter([
      'Latest request',
      '',
      `${request.amount} USDC`,
      request.memo,
      `Network: ${request.network}`,
      `Type: ${request.kind}`,
      '',
      ...progressLines(stats),
    ]),
    buttons: requestButtons(request),
  }
}

async function formatReminder(request: PaymentRequest, config: AppConfig) {
  const stats = await fetchRequestStats(request, config)
  return {
    text: withFooter([
      'Payment reminder',
      '',
      `${request.amount} USDC`,
      request.memo,
      `Network: ${request.network}`,
      '',
      ...progressLines(stats),
    ]),
    buttons: requestButtons(request),
  }
}

async function formatRecentRequests(requests: PaymentRequest[], config: AppConfig) {
  const recent = requests.slice(0, 5)
  if (!recent.length) {
    return { text: 'No recent requests found. Create one with /request 10 USDC for design.' }
  }
  const stats = await Promise.all(recent.map(request => fetchRequestStats(request, config)))

  return {
    text: withFooter([
      'Recent requests',
      '',
      ...recent.flatMap((request, index) => [
        `${index + 1}. ${request.amount} USDC - ${request.network}`,
        request.memo,
        stats[index]?.ok
          ? `${stats[index].count} paid · ${formatUsdc(stats[index].collected)} USDC collected`
          : 'Live status unavailable',
        `ID: ${request.id}`,
        '',
      ]).slice(0, -1),
    ]),
    buttonRows: recent.map((request, index) => [
      { text: `Pay ${index + 1}`, url: request.payUrl },
      { text: `Track ${index + 1}`, url: request.dashboardUrl },
    ]),
  }
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

function findRequest(id: string | undefined, profile: UserProfile) {
  if (!id) return undefined
  return requests.get(id)
    ?? (profile.latestRequest?.id === id ? profile.latestRequest : undefined)
    ?? profile.recentRequests?.find(item => item.id === id)
}

export async function handleCommand(text: string, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const trimmed = text.trim()
  const profile = context.store.getUser(context.userId)

  if (trimmed === '/start' || trimmed === '/help') {
    return {
      text: withFooter([
        'Hash PayLink Agent',
        '',
        'Create USDC payment links from chat.',
        'Requests are multi-payer collections by default.',
        '',
        'Commands:',
        '/setevm 0xYourAddress',
        '/setsol YourSolanaAddress',
        '/network solana',
        '/networks',
        '/request 10 USDC for design work',
        '/request 25 USDC for event ticket net=solana',
        '/me',
        '/requests',
        '/status',
        '/status <request-id>',
        '/remind',
        '/remind <request-id>',
        '',
        `Current default network: ${userNetwork(profile, config)}`,
      ]),
    }
  }

  if (trimmed.startsWith('/setevm')) {
    const address = trimmed.split(/\s+/)[1]
    if (!address || !isEvmAddress(address)) return { text: 'Use /setevm 0xYourEvmAddress' }
    await context.store.updateUser(context.userId, { evmAddress: address })
    return { text: withFooter([`EVM recipient saved: ${shortAddress(address)}`]) }
  }

  if (trimmed.startsWith('/setsol')) {
    const address = trimmed.split(/\s+/)[1]
    if (!address || !isLikelySolanaAddress(address)) return { text: 'Use /setsol YourSolanaAddress' }
    await context.store.updateUser(context.userId, { solanaAddress: address })
    return { text: withFooter([`Solana recipient saved: ${shortAddress(address)}`]) }
  }

  if (trimmed.startsWith('/network')) {
    const rawNetwork = trimmed.split(/\s+/)[1]
    if (!rawNetwork) {
      return {
        text: withFooter([
          `Current default network: ${userNetwork(profile, config)}`,
          '',
          'Use /network base, /network arbitrum, or /network solana.',
          '',
          ...NETWORK_HELP,
        ]),
      }
    }
    const nextNetwork = parseNetwork(rawNetwork, userNetwork(profile, config))
    await context.store.updateUser(context.userId, { defaultNetwork: nextNetwork })
    return { text: withFooter([`Default network saved: ${nextNetwork}`, '', 'Future /request commands will use this network unless you pass net=...']) }
  }

  if (trimmed === '/networks') {
    return { text: withFooter(NETWORK_HELP) }
  }

  if (trimmed === '/me') {
    return {
      text: withFooter([
        'Your Hash PayLink settings',
        '',
        `EVM: ${shortAddress(profile.evmAddress)}`,
        `Solana: ${shortAddress(profile.solanaAddress)}`,
        `Default network: ${userNetwork(profile, config)}`,
      ]),
    }
  }

  if (trimmed === '/request' || trimmed.startsWith('/request ')) {
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
      returnUrl: config.telegramReturnUrl,
    })
    requests.set(request.id, request)
    latestRequestByUser.set(context.userId, request.id)
    await context.store.updateUser(context.userId, {
      latestRequest: request,
      recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
    })
    return formatRequest(request)
  }

  if (trimmed === '/requests') {
    return formatRecentRequests(profile.recentRequests ?? [], config)
  }

  if (trimmed.startsWith('/status')) {
    const requestedId = trimmed.split(/\s+/)[1]
    const id = requestedId ?? latestRequestByUser.get(context.userId) ?? profile.latestRequest?.id
    if (!id) return { text: 'No recent request found. Create one with /request 10 USDC for design.' }
    const request = findRequest(id, profile)
    if (!request) return { text: 'Request not found in this bot session. Open the dashboard link from the original request to track older payments.' }
    return formatStatus(request, config)
  }

  if (trimmed.startsWith('/remind')) {
    const requestedId = trimmed.split(/\s+/)[1]
    const id = requestedId ?? latestRequestByUser.get(context.userId) ?? profile.latestRequest?.id
    if (!id) return { text: 'No recent request found. Create one with /request 10 USDC for design.' }
    const request = findRequest(id, profile)
    if (!request) return { text: 'Request not found in this bot session. Use /requests to see saved recent requests.' }
    return formatReminder(request, config)
  }

  return { text: 'Unknown command. Use /help.' }
}
