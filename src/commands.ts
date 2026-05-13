import type { AppConfig, Network } from './config.js'
import { buildPaymentRequest, type PaymentRequest } from './hashpaylink.js'
import type { ProfileStore, UserProfile } from './store.js'

export type CommandResult = {
  text: string
  buttons?: Array<{ text: string; url: string }>
  buttonRows?: Array<Array<{ text: string; url: string }>>
  forceReplyPlaceholder?: string
}

export type CommandContext = {
  userId: string
  store: ProfileStore
  replyToText?: string
}

const requests = new Map<string, PaymentRequest>()
const latestRequestByUser = new Map<string, string>()
const FOOTER = 'Built for Photon - Powered by Hash PayLink'
const MAX_USDC_WHOLE_DIGITS = 12
const MAX_MEMO_LENGTH = 180
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

function parseUsdcAmount(rawAmount: string | undefined): string | undefined {
  const normalized = (rawAmount ?? '').trim()
  const match = normalized.match(/^(\d+)(?:\.(\d{1,6})?)?$/)
  if (!match) return undefined
  const whole = match[1].replace(/^0+(?=\d)/, '')
  const fraction = match[2]?.replace(/0+$/, '') ?? ''
  if (whole.length > MAX_USDC_WHOLE_DIGITS) return undefined
  const rawUnits = BigInt(whole || '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
  if (rawUnits <= 0n) return undefined
  return fraction ? `${whole}.${fraction}` : whole
}

function parseRequestArgs(text: string, fallbackNetwork: Network): ParsedRequestArgs {
  const parts = text.trim().split(/\s+/)
  const amount = parseUsdcAmount(parts[1])
  if (!amount) {
    return { error: 'Use /request 10 USDC for design work. Amounts must use up to 6 decimals.' }
  }

  let network = fallbackNetwork
  const networkFlagIndex = parts.findIndex(part => part.startsWith('network=') || part.startsWith('net='))
  if (networkFlagIndex >= 0) {
    network = parseNetwork(parts[networkFlagIndex].split('=')[1], fallbackNetwork)
    parts.splice(networkFlagIndex, 1)
  }

  const memoStart = parts[2]?.toLowerCase() === 'usdc' ? 3 : 2
  const memo = parts.slice(memoStart).join(' ').replace(/^for\s+/i, '').trim() || 'Payment request'
  if (memo.length > MAX_MEMO_LENGTH) {
    return { error: `Memo is too long. Keep it under ${MAX_MEMO_LENGTH} characters.` }
  }
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

function commandName(text: string) {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return first.split('@')[0]
}

function promptForEvmRecipient(): CommandResult {
  return {
    text: withFooter([
      'Paste your EVM recipient address.',
      '',
      'Reply to this message with only the 0x wallet address.',
    ]),
    forceReplyPlaceholder: '0xYourEvmAddress',
  }
}

function promptForSolanaRecipient(): CommandResult {
  return {
    text: withFooter([
      'Paste your Solana recipient address.',
      '',
      'Reply to this message with only the Solana wallet address.',
    ]),
    forceReplyPlaceholder: 'YourSolanaAddress',
  }
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
  const cmd = commandName(trimmed)
  const profile = context.store.getUser(context.userId)
  const replyToText = context.replyToText ?? ''

  if (/Paste your EVM recipient address/i.test(replyToText)) {
    if (!isEvmAddress(trimmed)) return promptForEvmRecipient()
    await context.store.updateUser(context.userId, { evmAddress: trimmed })
    return { text: withFooter([`EVM recipient saved: ${shortAddress(trimmed)}`]) }
  }

  if (/Paste your Solana recipient address/i.test(replyToText)) {
    if (!isLikelySolanaAddress(trimmed)) return promptForSolanaRecipient()
    await context.store.updateUser(context.userId, { solanaAddress: trimmed })
    return { text: withFooter([`Solana recipient saved: ${shortAddress(trimmed)}`]) }
  }

  if (cmd === '/start' || cmd === '/help') {
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
        '/clear',
        '',
        `Current default network: ${userNetwork(profile, config)}`,
      ]),
    }
  }

  if (cmd === '/setevm') {
    const address = trimmed.split(/\s+/)[1]
    if (!address) return promptForEvmRecipient()
    if (!isEvmAddress(address)) return promptForEvmRecipient()
    await context.store.updateUser(context.userId, { evmAddress: address })
    return { text: withFooter([`EVM recipient saved: ${shortAddress(address)}`]) }
  }

  if (cmd === '/setsol') {
    const address = trimmed.split(/\s+/)[1]
    if (!address) return promptForSolanaRecipient()
    if (!isLikelySolanaAddress(address)) return promptForSolanaRecipient()
    await context.store.updateUser(context.userId, { solanaAddress: address })
    return { text: withFooter([`Solana recipient saved: ${shortAddress(address)}`]) }
  }

  if (cmd === '/network') {
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

  if (cmd === '/networks') {
    return { text: withFooter(NETWORK_HELP) }
  }

  if (cmd === '/me') {
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

  if (cmd === '/request') {
    const parsed = parseRequestArgs(trimmed, userNetwork(profile, config))
    if ('error' in parsed) return { text: parsed.error }

    const network = parsed.network
    const needsSolana = network === 'solana'
    const evmAddress = profile.evmAddress ?? config.defaultEvmAddress
    const solanaAddress = profile.solanaAddress ?? config.defaultSolanaAddress
    const recipientReady = needsSolana ? !!solanaAddress : !!evmAddress
    if (!recipientReady) {
      return needsSolana ? promptForSolanaRecipient() : promptForEvmRecipient()
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

  if (cmd === '/requests') {
    return formatRecentRequests(profile.recentRequests ?? [], config)
  }

  if (cmd === '/status') {
    const requestedId = trimmed.split(/\s+/)[1]
    const id = requestedId ?? latestRequestByUser.get(context.userId) ?? profile.latestRequest?.id
    if (!id) return { text: 'No recent request found. Create one with /request 10 USDC for design.' }
    const request = findRequest(id, profile)
    if (!request) return { text: 'Request not found in this bot session. Open the dashboard link from the original request to track older payments.' }
    return formatStatus(request, config)
  }

  if (cmd === '/remind') {
    const requestedId = trimmed.split(/\s+/)[1]
    const id = requestedId ?? latestRequestByUser.get(context.userId) ?? profile.latestRequest?.id
    if (!id) return { text: 'No recent request found. Create one with /request 10 USDC for design.' }
    const request = findRequest(id, profile)
    if (!request) return { text: 'Request not found in this bot session. Use /requests to see saved recent requests.' }
    return formatReminder(request, config)
  }

  return { text: 'Unknown command. Use /help.' }
}
