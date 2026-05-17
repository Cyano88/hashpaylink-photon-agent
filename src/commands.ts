import type { AppConfig, Network } from './config.js'
import { checkPolymarketRisk, formatPolymarketAlertStatus, sendDuePolymarketAlerts } from './polymarketAlerts.js'
import {
  buildPaymentRequest,
  buildPendingStreamRequest,
  buildStreamRequest,
  type AgentRegistration,
  type PendingStreamRequest,
  type PaymentRequest,
  type StreamRequest,
} from './hashpaylink.js'
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
const MAX_QUESTION_LENGTH = 1_000
const MAX_AGENT_SLUG_LENGTH = 32
const REQUEST_TIMEOUT_MS = 12_000
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
  '/request 10 USDC for design on solana',
  '/request 10 USDC for design on arbitrum',
]

const HELP_LINES = [
  'Hash PayLink Agent',
  '',
  'Instant Payments',
  '/request 10 USDC for design work',
  '/status',
  '/remind',
  '/requests',
  '',
  'Polymarket Watchlist',
  '/setpoly 0xYourPolymarketWallet',
  '/poly',
  '/setemail you@example.com',
  '/polyalerts on',
  '/polyalerts check',
  '',
  'Paid Polymarket LP Scout',
  '/lp best',
  '/lp crypto',
  '/lpmarket polymarket-url-or-slug',
  '',
  'AI Paid Access',
  '/askpaid your question',
  '/verifyagent name https://agent.example/ask price=2',
  '/agentwalletsetup name',
  '/setagentwallet name 0xCircleAgentWallet',
  '/setagentprice name 2',
  '/askagent name your question',
  '/setagentstream name 25 7d',
  '/streamagent name 25 USDC for 7d',
  '/agents',
  '',
  'Arc Streaming',
  '/stream 100 USDC to 0xRecipient for 7d reason="research retainer"',
  '/stream 100 USDC to recipient@email.com for 7d',
  '/streamready <pending-id>',
  '/streams',
  '',
  'Settings',
  '/setevm 0xYourAddress',
  '/setsol YourSolanaAddress',
  '/network solana',
  '/setpaid evm 0xHashPayLinkWallet',
  '/setpaid price 1',
  '/setlpprice 1',
  '/paidsettings',
  '/me',
  '/clear',
]

type RequestStats = {
  ok: boolean
  count: number
  collected: number
  archived: number
  error?: string
}

type ParsedPaidQuestionArgs =
  | { amount: string; question: string; network: Network }
  | { error: string }

type ParsedAgentRegistration =
  | { slug: string; endpointUrl: string; priceUsdc: string }
  | { error: string }

type ParsedStreamArgs =
  | { amount: string; recipient: string; recipientKind: 'address' | 'email'; duration: string; reason: string }
  | { error: string }

type ParsedAgentStreamArgs =
  | { slug: string; amount: string; duration: string; reason: string }
  | { error: string }

type ResolvedCircleRecipientWallet =
  | { found: true; walletAddress: string }
  | { found: false }
  | { error: string }

type PolymarketPosition = {
  title?: string
  outcome?: string
  size?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  curPrice?: number
}

type PolymarketValueResponse = {
  value?: number
  total?: number
  totalValue?: number
  currentValue?: number
}

type PolymarketRewardMarket = Record<string, unknown>

type PolymarketBookLevel = {
  price?: string | number
  size?: string | number
}

type PolymarketBookResponse = {
  bids?: PolymarketBookLevel[]
  asks?: PolymarketBookLevel[]
}

type PolymarketBookSummary = {
  bestBid?: number
  bestAsk?: number
  midpoint?: number
  spread?: number
}

type PolymarketLpOpportunity = {
  title: string
  slug?: string
  tokenId?: string
  endDate?: string
  daysToResolve?: number
  oneDayPriceChange?: number
  dailyReward?: number
  maxSpread?: number
  minSize?: number
  liquidity?: number
  bestBid?: number
  bestAsk?: number
  midpoint?: number
  spread?: number
  suggestedYesBid?: number
  suggestedNoBid?: number
  eligible?: boolean
  lpExecutionRisk: 'low' | 'medium' | 'high'
  outcomeRisk: 'medium' | 'high'
  score: number
}

function withFooter(lines: string[]) {
  return [...lines, '', FOOTER].join('\n')
}

function parseNetwork(raw: string | undefined, fallback: Network): Network {
  const value = normalizeNetworkName(raw)
  if (value) return value
  return fallback
}

function normalizeNetworkName(raw: string | undefined): Network | undefined {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'base' || value === 'base-mainnet') return 'base'
  if (value === 'arbitrum' || value === 'arb' || value === 'arbitrum-one') return 'arbitrum'
  if (value === 'solana' || value === 'sol') return 'solana'
  return undefined
}

function extractNetworkOverride(parts: string[], fallbackNetwork: Network): Network {
  let network = fallbackNetwork
  const networkFlagIndex = parts.findIndex(part => part.startsWith('network=') || part.startsWith('net='))
  if (networkFlagIndex >= 0) {
    network = parseNetwork(parts[networkFlagIndex].split('=')[1], fallbackNetwork)
    parts.splice(networkFlagIndex, 1)
  }

  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index]?.toLowerCase() !== 'on') continue
    const parsed = normalizeNetworkName(parts[index + 1])
    if (!parsed) continue
    network = parsed
    parts.splice(index, 2)
    break
  }

  return network
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

  const network = extractNetworkOverride(parts, fallbackNetwork)

  const memoStart = parts[2]?.toLowerCase() === 'usdc' ? 3 : 2
  const memo = parts.slice(memoStart).join(' ').replace(/^for\s+/i, '').trim() || 'Payment request'
  if (memo.length > MAX_MEMO_LENGTH) {
    return { error: `Memo is too long. Keep it under ${MAX_MEMO_LENGTH} characters.` }
  }
  return { amount, memo, network }
}

function parsePaidQuestionArgs(text: string, fallbackNetwork: Network): ParsedPaidQuestionArgs {
  const parts = text.trim().split(/\s+/)
  const network = extractNetworkOverride(parts, fallbackNetwork)

  const explicitAmount = parseUsdcAmount(parts[1])
  const amount = explicitAmount ?? ''
  const questionStart = explicitAmount ? (parts[2]?.toLowerCase() === 'usdc' ? 3 : 2) : 1
  const question = parts.slice(questionStart).join(' ').trim()
  if (!question) return { error: 'Add a question. Example: /askpaid What should I build on Arc?' }
  if (question.length > MAX_QUESTION_LENGTH) return { error: `Question is too long. Keep it under ${MAX_QUESTION_LENGTH} characters.` }
  return { amount, question, network }
}

function normalizeAgentSlug(value: string | undefined) {
  const slug = (value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(slug)) return undefined
  return slug.slice(0, MAX_AGENT_SLUG_LENGTH)
}

function parsePriceFlag(parts: string[]) {
  const index = parts.findIndex(part => part.startsWith('price='))
  if (index < 0) return undefined
  const amount = parseUsdcAmount(parts[index]?.split('=')[1])
  if (!amount) return undefined
  parts.splice(index, 1)
  return amount
}

function parseAgentRegistrationArgs(text: string): ParsedAgentRegistration {
  const parts = text.trim().split(/\s+/)
  const slug = normalizeAgentSlug(parts[1])
  const endpointUrl = parts[2]?.trim()
  const priceUsdc = parsePriceFlag(parts) ?? parseUsdcAmount(parts[3])
  if (!slug || !endpointUrl || !priceUsdc) {
    return { error: 'Use /verifyagent marketbot https://api.example.com/ask price=2' }
  }
  return { slug, endpointUrl, priceUsdc }
}

function parseStreamArgs(text: string): ParsedStreamArgs {
  const parts = text.trim().split(/\s+/)
  const amount = parseUsdcAmount(parts[1])
  if (!amount) return { error: 'Use /stream 100 USDC to 0xRecipient for 7d reason="research retainer".' }

  const toIndex = parts.findIndex(part => part.toLowerCase() === 'to')
  const forIndex = parts.findIndex(part => part.toLowerCase() === 'for')
  if (toIndex < 0 || forIndex < 0 || !parts[toIndex + 1] || !parts[forIndex + 1]) {
    return { error: 'Use /stream 100 USDC to 0xRecipient for 7d reason="research retainer".' }
  }

  const recipient = parts[toIndex + 1]
  const recipientKind = isEvmAddress(recipient) ? 'address' : isEmail(recipient) ? 'email' : undefined
  if (!recipientKind) return { error: 'Stream recipient must be an EVM 0x address or recipient@email.com.' }

  const duration = parts[forIndex + 1].toLowerCase()
  if (!/^\d+[dhw]$/.test(duration)) return { error: 'Duration must look like 7d, 24h, or 2w.' }

  const reasonMatch = text.match(/\breason=(?:"([^"]+)"|(.+))$/i)
  const reason = (reasonMatch?.[1] ?? reasonMatch?.[2] ?? 'Arc USDC stream').trim().slice(0, MAX_MEMO_LENGTH)
  return { amount, recipient: recipient.toLowerCase(), recipientKind, duration, reason }
}

function parseAgentStreamArgs(text: string, agent?: AgentRegistration): ParsedAgentStreamArgs {
  const parts = text.trim().split(/\s+/)
  const slug = normalizeAgentSlug(parts[1])
  if (!slug) return { error: 'Use /streamagent agent-name 25 USDC for 7d reason="monitoring retainer".' }

  const explicitAmount = parseUsdcAmount(parts[2])
  const amount = explicitAmount ?? agent?.streamPriceUsdc
  let duration = agent?.streamDuration
  let reasonStart = 2

  if (explicitAmount) {
    const forIndex = parts.findIndex((part, index) => index > 2 && part.toLowerCase() === 'for')
    const durationCandidate = forIndex >= 0 ? parts[forIndex + 1]?.toLowerCase() : undefined
    if (!durationCandidate || !/^\d+[dhw]$/.test(durationCandidate)) {
      return { error: 'Use /streamagent agent-name 25 USDC for 7d reason="monitoring retainer".' }
    }
    duration = durationCandidate
    reasonStart = forIndex + 2
  }

  if (!amount || !duration || !/^\d+[dhw]$/.test(duration)) {
    return { error: `No default stream retainer is set for ${slug}. Use /streamagent ${slug} 25 USDC for 7d.` }
  }

  const reasonMatch = text.match(/\breason=(?:"([^"]+)"|(.+))$/i)
  const reason = (reasonMatch?.[1] ?? reasonMatch?.[2] ?? parts.slice(reasonStart).join(' ').replace(/^reason=/i, '') ?? '').trim()
  return {
    slug,
    amount,
    duration,
    reason: (reason || `Agent retainer: ${slug}`).slice(0, MAX_MEMO_LENGTH),
  }
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

function answerButtons(request: PaymentRequest) {
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

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase())
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

function promptForPolymarketAddress(): CommandResult {
  return {
    text: withFooter([
      'Paste your Polymarket public wallet address.',
      '',
      'This is the 0x address from your Polymarket profile. It is used only for public portfolio lookup.',
    ]),
    forceReplyPlaceholder: '0xYourPolymarketWallet',
  }
}

function getRecipientForNetwork(profile: UserProfile, config: AppConfig, network: Network) {
  return network === 'solana'
    ? profile.solanaAddress ?? config.defaultSolanaAddress
    : profile.evmAddress ?? config.defaultEvmAddress
}

function getPlatformRecipientForNetwork(store: ProfileStore, config: AppConfig, network: Network) {
  const platform = store.getPlatform()
  return network === 'solana'
    ? platform.solanaAddress ?? config.defaultSolanaAddress
    : platform.evmAddress ?? config.defaultEvmAddress
}

function getAgentOwnerRecipientForNetwork(agent: AgentRegistration, store: ProfileStore, config: AppConfig, network: Network) {
  const ownerProfile = store.getUser(agent.ownerUserId)
  if (network !== 'solana' && agent.agentWalletAddress) return agent.agentWalletAddress
  return network === 'solana' ? ownerProfile.solanaAddress : ownerProfile.evmAddress
}

function agentWalletSetupText(agent: AgentRegistration) {
  return withFooter([
    'Circle Agent Wallet setup',
    '',
    `Agent: ${agent.slug}`,
    '',
    'Minimal Agent Stack path:',
    '1. Install/login with Circle CLI.',
    '2. Create an Arc testnet Agent Wallet.',
    '3. Copy the 0x wallet address.',
    '4. Register it here:',
    `/setagentwallet ${agent.slug} 0xAgentWallet`,
    '',
    'Circle CLI docs:',
    'https://developers.circle.com/agent-stack/circle-cli',
    '',
    'Agent Wallet quickstart:',
    'https://developers.circle.com/agent-stack/agent-wallets/quickstart',
  ])
}

function paidAccessPayerHint(request: PaymentRequest) {
  return [
    'After paying, reply with the name you entered on the payment page:',
    '/answer your-name',
    '',
    'Advanced:',
    `/answer ${request.id} your-name`,
  ]
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchPolymarketJson(url: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'HashPayLinkPhotonAgent/0.1',
        },
      })
      if (!response.ok) return null
      return await response.json() as unknown
    } catch (err) {
      lastError = err
      await sleep(250 * (attempt + 1))
    }
  }
  if (lastError) console.warn('[polymarket] request failed:', lastError instanceof Error ? lastError.message : String(lastError))
  return null
}

async function fetchPolymarketPositions(address: string) {
  const response = await fetchWithTimeout(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(address)}&limit=5&sortBy=CURRENT&sortDirection=DESC&sizeThreshold=0`)
  if (!response.ok) throw new Error('Could not fetch Polymarket positions.')
  return await response.json() as PolymarketPosition[]
}

async function fetchPolymarketValue(address: string) {
  const response = await fetchWithTimeout(`https://data-api.polymarket.com/value?user=${encodeURIComponent(address)}`)
  if (!response.ok) return null
  const data = await response.json() as PolymarketValueResponse | number
  if (typeof data === 'number') return data
  return data.value ?? data.totalValue ?? data.currentValue ?? data.total ?? null
}

function formatUsdValue(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unavailable'
  return `${formatUsdc(value)} USDC`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readNestedNumber(record: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = record
    for (const part of path) {
      const currentRecord = asRecord(current)
      current = currentRecord?.[part]
    }
    const parsed = typeof current === 'number' ? current : typeof current === 'string' ? Number(current) : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeProbability(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const normalized = value > 1 && value <= 100 ? value / 100 : value
  return Math.min(0.99, Math.max(0.01, normalized))
}

function normalizeSpread(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0) return undefined
  return value > 1 ? value / 100 : value
}

function clampPrice(value: number) {
  return Math.min(0.99, Math.max(0.01, value))
}

function formatCents(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1).replace(/\.0$/, '')}c` : 'n/a'
}

function formatOptionalUsdc(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatUsdc(value)} USDC` : 'n/a'
}

function daysUntil(rawDate: string | undefined) {
  if (!rawDate) return undefined
  const date = new Date(rawDate)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 86_400_000))
}

function formatDays(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown'
  if (value === 0) return 'today'
  if (value === 1) return '1 day'
  return `${value} days`
}

function extractPolymarketSlug(raw: string) {
  const value = raw.trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.at(-1) ?? value
  } catch {
    return value.replace(/^\/+|\/+$/g, '')
  }
}

function extractRewardMarkets(data: unknown): PolymarketRewardMarket[] {
  if (Array.isArray(data)) return data.map(asRecord).filter((item): item is PolymarketRewardMarket => Boolean(item))
  const record = asRecord(data)
  if (!record) return []
  for (const key of ['data', 'markets', 'results']) {
    const value = record[key]
    if (Array.isArray(value)) return value.map(asRecord).filter((item): item is PolymarketRewardMarket => Boolean(item))
  }
  return []
}

async function fetchPolymarketRewardMarkets(query?: string) {
  const search = query ? `&q=${encodeURIComponent(query)}` : ''
  const urls = [
    `https://clob.polymarket.com/rewards/markets/multi?page_size=100&order_by=rate_per_day&position=DESC${search}`,
    'https://clob.polymarket.com/rewards/markets/current',
  ]

  for (const url of urls) {
    const data = await fetchPolymarketJson(url)
    const markets = extractRewardMarkets(data)
    if (markets.length) return markets
  }

  return []
}

function extractPolymarketTokenIds(market: PolymarketRewardMarket) {
  const ids = new Set<string>()
  for (const key of ['token_id', 'tokenId', 'asset_id', 'assetId', 'clobTokenId']) {
    const value = market[key]
    if (typeof value === 'string' && value.trim()) ids.add(value.trim())
    if (typeof value === 'number' && Number.isFinite(value)) ids.add(String(value))
  }

  for (const key of ['tokens', 'outcomes', 'outcomeTokens', 'rewards']) {
    const items = market[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const record = asRecord(item)
      if (!record) continue
      for (const idKey of ['token_id', 'tokenId', 'asset_id', 'assetId', 'clobTokenId']) {
        const value = record[idKey]
        if (typeof value === 'string' && value.trim()) ids.add(value.trim())
        if (typeof value === 'number' && Number.isFinite(value)) ids.add(String(value))
      }
    }
  }

  return [...ids]
}

function readBookPrice(level: PolymarketBookLevel) {
  const parsed = typeof level.price === 'number' ? level.price : typeof level.price === 'string' ? Number(level.price) : Number.NaN
  return normalizeProbability(parsed)
}

async function fetchPolymarketBook(tokenId: string): Promise<PolymarketBookSummary> {
  const data = await fetchPolymarketJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`) as PolymarketBookResponse | null
  if (!data) return {}
  const bidPrices = (data.bids ?? []).map(readBookPrice).filter((price): price is number => typeof price === 'number')
  const askPrices = (data.asks ?? []).map(readBookPrice).filter((price): price is number => typeof price === 'number')
  const bestBid = bidPrices.length ? Math.max(...bidPrices) : undefined
  const bestAsk = askPrices.length ? Math.min(...askPrices) : undefined
  const spread = typeof bestBid === 'number' && typeof bestAsk === 'number' ? Math.max(0, bestAsk - bestBid) : undefined
  const midpoint = typeof bestBid === 'number' && typeof bestAsk === 'number' ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk
  return { bestBid, bestAsk, midpoint, spread }
}

function baseLpOpportunity(market: PolymarketRewardMarket): PolymarketLpOpportunity {
  const title = readString(market, ['question', 'title', 'market_slug', 'slug', 'condition_id']) ?? 'Untitled reward market'
  const rewardsConfig = Array.isArray(market.rewards_config) ? market.rewards_config : []
  const configDailyReward = rewardsConfig.reduce((sum, item) => {
    const record = asRecord(item)
    return sum + (record ? readNumber(record, ['rate_per_day', 'ratePerDay']) ?? 0 : 0)
  }, 0)
  const dailyReward =
    readNumber(market, ['total_daily_rate', 'native_daily_rate', 'daily_reward', 'dailyRewards', 'rewards_daily_rate', 'rate_per_day', 'reward']) ??
    (configDailyReward > 0 ? configDailyReward : undefined) ??
    readNestedNumber(market, [['reward_config', 'daily_reward'], ['rewardConfig', 'dailyReward']])
  const maxSpread = normalizeSpread(
    readNumber(market, ['max_spread', 'maxSpread', 'rewards_max_spread', 'rewardsMaxSpread']) ??
    readNestedNumber(market, [['reward_config', 'max_spread'], ['rewardConfig', 'maxSpread']]),
  )
  const minSize =
    readNumber(market, ['min_size', 'minSize', 'rewards_min_size', 'rewardsMinSize']) ??
    readNestedNumber(market, [['reward_config', 'min_size'], ['rewardConfig', 'minSize']])
  const liquidity = readNumber(market, ['liquidity', 'volume_24hr', 'volume24hr', 'volume', 'oneDayVolume'])
  const endDate = readString(market, ['end_date', 'endDate', 'resolution_date', 'resolutionDate', 'closed_time'])

  return {
    title,
    slug: readString(market, ['slug', 'market_slug', 'event_slug']),
    tokenId: extractPolymarketTokenIds(market)[0],
    endDate,
    daysToResolve: daysUntil(endDate),
    oneDayPriceChange: readNumber(market, ['one_day_price_change', 'oneDayPriceChange', 'price_change_24h', 'priceChange24h']),
    dailyReward,
    maxSpread,
    minSize,
    liquidity,
    lpExecutionRisk: 'medium',
    outcomeRisk: 'high',
    score: 0,
  }
}

async function analyzePolymarketLpMarket(market: PolymarketRewardMarket): Promise<PolymarketLpOpportunity> {
  const opportunity = baseLpOpportunity(market)
  const book: PolymarketBookSummary = opportunity.tokenId ? await fetchPolymarketBook(opportunity.tokenId).catch(() => ({})) : {}
  const midpoint = book.midpoint ?? normalizeProbability(readNumber(market, ['last_trade_price', 'lastPrice', 'price', 'midpoint']))
  const spread = book.spread
  const offset = Math.min(0.02, Math.max(0.005, (opportunity.maxSpread ?? 0.03) * 0.35))
  const suggestedYesBid = typeof midpoint === 'number' ? clampPrice(midpoint - offset) : undefined
  const suggestedNoBid = typeof midpoint === 'number' ? clampPrice((1 - midpoint) - offset) : undefined
  const eligible = typeof spread === 'number' && typeof opportunity.maxSpread === 'number' ? spread <= opportunity.maxSpread : undefined

  let lpExecutionRisk: PolymarketLpOpportunity['lpExecutionRisk'] = 'medium'
  if (typeof midpoint === 'number' && (midpoint < 0.08 || midpoint > 0.92)) lpExecutionRisk = 'high'
  if (typeof spread === 'number' && typeof opportunity.maxSpread === 'number' && spread > opportunity.maxSpread) lpExecutionRisk = 'high'
  if (typeof opportunity.oneDayPriceChange === 'number' && Math.abs(opportunity.oneDayPriceChange) > 0.08) lpExecutionRisk = 'high'
  if (lpExecutionRisk !== 'high' && typeof spread === 'number' && spread <= 0.02 && typeof midpoint === 'number' && midpoint > 0.15 && midpoint < 0.85) {
    lpExecutionRisk = 'low'
  }
  const outcomeRisk: PolymarketLpOpportunity['outcomeRisk'] = 'high'

  const rewardScore = Math.min(150, opportunity.dailyReward ?? 0)
  const liquidityScore = Math.min(500, opportunity.liquidity ?? 0) / 25
  const eligibilityScore = eligible === false ? -50 : eligible === true ? 25 : 0
  const durationScore = typeof opportunity.daysToResolve === 'number'
    ? Math.min(35, Math.max(-60, opportunity.daysToResolve - 7))
    : 0
  const nearResolutionPenalty = typeof opportunity.daysToResolve === 'number' && opportunity.daysToResolve < 7 ? 75 : 0
  const volatilityPenalty = typeof opportunity.oneDayPriceChange === 'number' ? Math.min(60, Math.abs(opportunity.oneDayPriceChange) * 400) : 8
  const spreadPenalty = typeof spread === 'number' ? spread * 100 : 8
  const riskPenalty = lpExecutionRisk === 'high' ? 30 : lpExecutionRisk === 'medium' ? 10 : 0

  return {
    ...opportunity,
    ...book,
    midpoint,
    suggestedYesBid,
    suggestedNoBid,
    eligible,
    lpExecutionRisk,
    outcomeRisk,
    score: rewardScore + liquidityScore + eligibilityScore + durationScore - spreadPenalty - riskPenalty - volatilityPenalty - nearResolutionPenalty,
  }
}

function formatLpOpportunity(opportunity: PolymarketLpOpportunity, index?: number) {
  const prefix = typeof index === 'number' ? `${index}. ` : ''
  return [
    `${prefix}${opportunity.title.slice(0, 90)}`,
    `Reward/day: ${formatOptionalUsdc(opportunity.dailyReward)} | Max spread: ${formatCents(opportunity.maxSpread)} | Min size: ${formatOptionalUsdc(opportunity.minSize)}`,
    `Time to resolve: ${formatDays(opportunity.daysToResolve)} | 24h move: ${formatCents(opportunity.oneDayPriceChange)}`,
    `Book: bid ${formatCents(opportunity.bestBid)} / ask ${formatCents(opportunity.bestAsk)} | live spread ${formatCents(opportunity.spread)}`,
    `Suggested maker quote: YES ${formatCents(opportunity.suggestedYesBid)} / NO ${formatCents(opportunity.suggestedNoBid)}`,
    `LP execution risk: ${opportunity.lpExecutionRisk} | Outcome risk: ${opportunity.outcomeRisk}`,
    `Reward check: ${opportunity.eligible === true ? 'inside reward spread' : opportunity.eligible === false ? 'outside reward spread' : 'needs live book review'}`,
    opportunity.slug ? `Market: https://polymarket.com/market/${opportunity.slug}` : undefined,
  ].filter((line): line is string => Boolean(line))
}

async function formatPolymarketLpScoutResult(rawQuery: string): Promise<CommandResult> {
  const query = rawQuery.replace(/^\/lp\b/i, '').trim()
  const topic = !query || query.toLowerCase() === 'best' ? '' : query.toLowerCase()
  const markets = await fetchPolymarketRewardMarkets(topic)
  if (!markets.length) {
    return { text: 'Polymarket reward markets are unavailable right now. Try again shortly.' }
  }

  const filtered = topic
    ? markets.filter(market => {
      const opportunity = baseLpOpportunity(market)
      return `${opportunity.title} ${opportunity.slug ?? ''}`.toLowerCase().includes(topic)
    })
    : markets
  const candidates = filtered.slice(0, 12)
  if (!candidates.length) {
    return { text: `No active Polymarket reward markets matched "${query}". Try /lp best.` }
  }

  const opportunities = await Promise.all(candidates.map(analyzePolymarketLpMarket))
  const ranked = opportunities.sort((a, b) => b.score - a.score).slice(0, 3)
  return {
    text: withFooter([
      'Polymarket LP Scout',
      '',
      'Educational signal only. It prioritizes longer-running reward markets with tighter spreads and lower short-term volatility.',
      'Outcome risk is always high: this is not a safe bet or a prediction.',
      '',
      ...ranked.flatMap((opportunity, index) => [
        ...formatLpOpportunity(opportunity, index + 1),
        '',
      ]).slice(0, -1),
      '',
      'To watch your public positions:',
      '/setpoly 0xYourPolymarketWallet',
      '/poly',
    ]),
  }
}

async function formatSinglePolymarketMarket(rawInput: string): Promise<CommandResult> {
  const input = rawInput.replace(/^\/lpmarket\b/i, '').trim()
  const slug = extractPolymarketSlug(input).toLowerCase()
  if (!slug) return { text: 'Add a Polymarket URL or slug. Example: /lpmarket will-bitcoin-hit-100k' }
  const markets = await fetchPolymarketRewardMarkets(slug.replace(/-/g, ' '))
  const match = markets.find(market => {
    const opportunity = baseLpOpportunity(market)
    return [opportunity.slug, opportunity.title].some(value => value?.toLowerCase().includes(slug) || slug.includes(value?.toLowerCase() ?? ''))
  })
  if (!match) return { text: `I could not find that active reward market. Try /lp best or paste the exact Polymarket market URL.` }
  const opportunity = await analyzePolymarketLpMarket(match)
  return {
    text: withFooter([
      'Polymarket LP Market',
      '',
      ...formatLpOpportunity(opportunity),
      '',
      'Use this as a quote-planning check, not financial advice. Confirm the live book on Polymarket before placing orders.',
    ]),
  }
}

async function createPaidLpRequest(rawQuery: string, profile: UserProfile, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const platform = context.store.getPlatform()
  const amount = platform.polymarketLpPriceUsdc
  if (!amount) {
    return { text: 'Polymarket LP Scout price is not set. Ask a Hash PayLink admin to run /setlpprice 1.' }
  }

  const network = userNetwork(profile, config)
  const recipient = getPlatformRecipientForNetwork(context.store, config, network)
  if (!recipient) {
    return { text: `Polymarket LP Scout recipient is not configured for ${network}. Ask the Hash PayLink admin to set /setpaid evm or /setpaid solana.` }
  }

  const request = buildPaymentRequest({
    baseUrl: config.hashPayLinkBaseUrl,
    amount,
    memo: 'Hash PayLink Polymarket LP Scout access',
    network,
    evmAddress: network === 'solana' ? context.store.getPlatform().evmAddress ?? config.defaultEvmAddress : recipient,
    solanaAddress: network === 'solana' ? recipient : context.store.getPlatform().solanaAddress ?? config.defaultSolanaAddress,
    returnUrl: config.telegramReturnUrl,
    kind: 'lp_access',
    question: rawQuery,
  })
  requests.set(request.id, request)
  latestRequestByUser.set(context.userId, request.id)
  await context.store.updateUser(context.userId, {
    latestRequest: request,
    recentLpRequests: [request, ...(profile.recentLpRequests ?? [])].slice(0, 5),
    recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
  })

  return {
    text: withFooter([
      'Polymarket LP Scout access created',
      '',
      `${request.amount} USDC`,
      `Network: ${request.network}`,
      `Request: ${rawQuery || '/lp best'}`,
      '',
      'Pay to unlock the LP scan.',
      ...paidAccessPayerHint(request),
    ]),
    buttons: answerButtons(request),
  }
}

async function formatPolymarketPortfolio(profile: UserProfile): Promise<CommandResult> {
  const address = profile.polymarketAddress
  if (!address) return promptForPolymarketAddress()

  try {
    const [positions, value] = await Promise.all([
      fetchPolymarketPositions(address),
      fetchPolymarketValue(address),
    ])
    return {
      text: withFooter([
        'Polymarket account',
        '',
        `Wallet: ${shortAddress(address)}`,
        `Open position value: ${formatUsdValue(value)}`,
        `Open positions: ${positions.length}`,
        '',
        ...(positions.length
          ? positions.flatMap((position, index) => [
            `${index + 1}. ${(position.title ?? 'Untitled market').slice(0, 80)}`,
            `${position.outcome ?? 'Outcome'} - ${formatUsdValue(position.currentValue)} at ${typeof position.curPrice === 'number' ? `${Math.round(position.curPrice * 100)}c` : 'market price unavailable'}`,
            `PnL: ${formatUsdValue(position.cashPnl)}${typeof position.percentPnl === 'number' ? ` (${position.percentPnl.toFixed(2)}%)` : ''}`,
            '',
          ]).slice(0, -1)
          : ['No open positions found from the public Data API.']),
        '',
        'To fund:',
        '/setpoly 0xYourPolymarketWallet',
        '/poly',
      ]),
    }
  } catch {
    return { text: 'Could not fetch Polymarket portfolio right now. Try again shortly.' }
  }
}

function isPublicHttpsUrl(raw: string) {
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:') return false
    if (hostname === 'localhost' || hostname.endsWith('.local')) return false
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.|169\.254\.)/.test(hostname)) return false
    return true
  } catch {
    return false
  }
}

async function verifyAgentEndpoint(parsed: ParsedAgentRegistration & { error?: never }, userId: string): Promise<AgentRegistration | { error: string }> {
  if (!isPublicHttpsUrl(parsed.endpointUrl)) {
    return { error: 'Agent URL must be a public HTTPS endpoint.' }
  }

  try {
    const response = await fetchWithTimeout(parsed.endpointUrl, { method: 'GET' })
    if (response.status >= 500) {
      return { error: 'Agent endpoint responded with a server error. Fix it and try again.' }
    }
  } catch {
    return { error: 'Agent endpoint did not respond. Make sure the URL is live and try again.' }
  }

  return {
    slug: parsed.slug,
    endpointUrl: parsed.endpointUrl,
    priceUsdc: parsed.priceUsdc,
    ownerUserId: userId,
    status: 'active',
    createdAt: Date.now(),
    verifiedAt: Date.now(),
  }
}

async function callBuiltInAi(request: PaymentRequest, payer: string, config: AppConfig) {
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const response = await fetchWithTimeout(`${base}/api/agent-ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: request.id,
      payer,
      question: request.question ?? request.memo,
    }),
  })
  const data = await response.json() as {
    answer?: string
    error?: string
    paymentVerified?: boolean
    proof?: { ogExplorer?: string; rootHash?: string }
  }
  if (!response.ok || !data.paymentVerified) {
    return { error: data.error ?? 'Payment is not verified on 0G yet. Try again shortly.' }
  }
  return { answer: data.answer ?? 'No answer returned.', proof: data.proof }
}

async function callExternalAgent(agent: AgentRegistration, request: PaymentRequest, payer: string, config: AppConfig) {
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const verifyUrl = `${base}/api/agent-verify?eventId=${encodeURIComponent(request.id)}&payer=${encodeURIComponent(payer)}`
  const verifyResponse = await fetchWithTimeout(verifyUrl)
  const proof = await verifyResponse.json() as {
    verified?: boolean
    error?: string
    payment?: unknown
    proof?: unknown
  }
  if (!verifyResponse.ok || !proof.verified) {
    return { error: proof.error ?? 'Payment is not verified on 0G yet. Try again shortly.' }
  }

  const agentResponse = await fetchWithTimeout(agent.endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: request.question,
      payment: proof.payment,
      proof: proof.proof,
      source: 'hashpaylink-photon-agent',
    }),
  })
  const contentType = agentResponse.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? await agentResponse.json() as { answer?: string; text?: string; message?: string }
    : { text: await agentResponse.text() }
  const answer = payload.answer ?? payload.text ?? payload.message

  if (!agentResponse.ok) return { error: 'Verified payment, but the agent endpoint failed.' }
  return { answer: (answer || 'Agent returned no answer.').slice(0, 3_500), proof: proof.proof as { ogExplorer?: string; rootHash?: string } | undefined }
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

function latestPaidAccessRequest(profile: UserProfile) {
  const recent = [...(profile.recentAiRequests ?? []), ...(profile.recentLpRequests ?? [])]
  return recent.find(request => request.kind === 'ai_access' || request.kind === 'agent_access' || request.kind === 'lp_access')
    ?? (profile.latestRequest?.kind === 'ai_access' || profile.latestRequest?.kind === 'agent_access' || profile.latestRequest?.kind === 'lp_access'
      ? profile.latestRequest
      : undefined)
}

function parseAnswerArgs(text: string, profile: UserProfile): { request?: PaymentRequest; payer?: string; error?: string } {
  const [, first, ...rest] = text.trim().split(/\s+/)
  if (!first) return { error: 'After paying, reply with /answer your-name.' }

  const explicitRequest = findRequest(first, profile)
  if (explicitRequest) {
    const payer = rest.join(' ').trim()
    if (!payer) return { error: `Add the payer name. Example: /answer ${explicitRequest.id} Emmanuel` }
    return { request: explicitRequest, payer }
  }

  if (first.toUpperCase() === 'REQUEST_ID') {
    return { error: 'Replace REQUEST_ID with the real request ID, or use the simpler format: /answer your-name.' }
  }
  if (/^[a-f0-9]{12,32}$/i.test(first) && rest.length > 0) {
    return { error: 'That request ID was not found. You can also use the latest paid access request with: /answer your-name.' }
  }

  const latest = latestPaidAccessRequest(profile)
  if (!latest) return { error: 'No paid access request found yet. Create one with /askpaid or /askagent first.' }
  return { request: latest, payer: [first, ...rest].join(' ').trim() }
}

function parsePaidAs(text: string, profile: UserProfile): { request?: PaymentRequest; payer?: string; error?: string } | undefined {
  const match = text.trim().match(/^i\s+paid\s+as\s+(.+)$/i)
  if (!match) return undefined
  const latest = latestPaidAccessRequest(profile)
  if (!latest) return { error: 'No paid access request found yet. Create one with /askpaid or /askagent first.' }
  return { request: latest, payer: match[1].trim() }
}

function isAdmin(config: AppConfig, userId: string) {
  return config.adminUserIds.includes(userId)
}

function adminRequiredText() {
  return withFooter([
    'Only a Hash PayLink admin can update the built-in paid AI recipient.',
    '',
    'Send /me to see your Telegram user ID, then add it to ADMIN_USER_IDS on the Photon agent service.',
  ])
}

function paidSettingsText(store: ProfileStore, config: AppConfig) {
  const platform = store.getPlatform()
  return withFooter([
    'Built-in paid AI recipient settings',
    '',
    `EVM: ${shortAddress(platform.evmAddress ?? config.defaultEvmAddress)}`,
    `Solana: ${shortAddress(platform.solanaAddress ?? config.defaultSolanaAddress)}`,
    `Paid AI price: ${platform.paidAiPriceUsdc ?? 'not set'} USDC`,
    `Polymarket LP Scout price: ${platform.polymarketLpPriceUsdc ?? 'not set'} USDC`,
    '',
    'Set from Telegram:',
    '/setpaid evm 0xYourWallet',
    '/setpaid solana YourSolanaWallet',
    '/setpaid price 1',
    '/setlpprice 1',
  ])
}

async function answerPaidAccessRequest(
  request: PaymentRequest,
  payer: string,
  config: AppConfig,
  context: CommandContext,
): Promise<CommandResult> {
  if (request.kind !== 'ai_access' && request.kind !== 'agent_access' && request.kind !== 'lp_access') {
    return { text: 'That request is a normal payment request, not paid access.' }
  }

  if (request.kind === 'lp_access') {
    const verifyUrl = `${config.hashPayLinkBaseUrl.replace(/\/+$/, '')}/api/agent-verify?eventId=${encodeURIComponent(request.id)}&payer=${encodeURIComponent(payer)}`
    const verifyResponse = await fetchWithTimeout(verifyUrl)
    const proof = await verifyResponse.json() as { verified?: boolean; proof?: { ogExplorer?: string } }
    if (!verifyResponse.ok || !proof.verified) {
      return { text: `Payment required. No verified LP Scout payment found for "${payer}" yet. If you just paid, wait 30-60 seconds and retry /answer ${payer}.` }
    }
    const result = await formatPolymarketLpScoutResult(request.question || '/lp best')
    return {
      text: [
        'Payment verified on 0G.',
        'Access: Polymarket LP Scout',
        '',
        result.text,
        '',
        proof.proof?.ogExplorer ? `Proof: ${proof.proof.ogExplorer}` : 'Proof: 0G verification returned',
      ].join('\n'),
    }
  }

  if (request.kind === 'agent_access') {
    const agent = request.agentSlug ? context.store.getAgent(request.agentSlug) : undefined
    if (!agent || agent.status !== 'active') return { text: 'Agent is no longer active on Hash PayLink.' }
    const result = await callExternalAgent(agent, request, payer, config)
    if ('error' in result) return { text: result.error ?? 'Agent access failed.' }
    return {
      text: withFooter([
        'Payment verified on 0G.',
        `Agent: ${agent.slug}`,
        '',
        'Answer:',
        result.answer ?? '',
        '',
        result.proof?.ogExplorer ? `Proof: ${result.proof.ogExplorer}` : 'Proof: 0G verification returned',
      ]),
    }
  }

  const result = await callBuiltInAi(request, payer, config)
  if ('error' in result) return { text: result.error ?? 'AI access failed.' }
  return {
    text: withFooter([
      'Payment verified on 0G.',
      'Agent: Hash PayLink Circle/Arc/Polymarket Strategy AI',
      '',
      'Answer:',
      result.answer ?? '',
      '',
      result.proof?.ogExplorer ? `Proof: ${result.proof.ogExplorer}` : 'Proof: 0G verification returned',
    ]),
  }
}

function findPendingStream(id: string | undefined, profile: UserProfile) {
  if (!id) return undefined
  return profile.pendingStreams?.find(stream => stream.id === id)
}

async function resolveCircleRecipientWallet(baseUrl: string, recipientEmail: string): Promise<ResolvedCircleRecipientWallet> {
  const base = baseUrl.replace(/\/+$/, '')
  const response = await fetchWithTimeout(`${base}/api/circle-recipient-wallet?email=${encodeURIComponent(recipientEmail)}`)
  const data = await response.json() as { ok?: boolean; found?: boolean; walletAddress?: string; error?: string }
  if (!response.ok || !data.ok) return { error: data.error ?? 'Could not resolve Circle recipient wallet.' }
  if (!data.found || !data.walletAddress) return { found: false }
  if (!isEvmAddress(data.walletAddress)) return { error: 'Resolved Circle wallet address is invalid.' }
  return { found: true, walletAddress: data.walletAddress }
}

export async function handleCommand(text: string, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const trimmed = text.trim()
  const cmd = commandName(trimmed)
  const profile = context.store.getUser(context.userId)
  const replyToText = context.replyToText ?? ''
  const paidAs = parsePaidAs(trimmed, profile)
  if (paidAs) {
    if (paidAs.error || !paidAs.request || !paidAs.payer) return { text: paidAs.error ?? 'Use /answer your-name.' }
    return answerPaidAccessRequest(paidAs.request, paidAs.payer, config, context)
  }

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

  if (/Paste your Polymarket public wallet address/i.test(replyToText)) {
    if (!isEvmAddress(trimmed)) return promptForPolymarketAddress()
    await context.store.updateUser(context.userId, {
      polymarketAddress: trimmed,
    })
    return {
      text: withFooter([
        `Polymarket wallet saved: ${shortAddress(trimmed)}`,
        'This is used only for public position/value lookup.',
      ]),
    }
  }

  if (cmd === '/start' || cmd === '/help') {
    return {
      text: withFooter([
        ...HELP_LINES,
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

  if (cmd === '/setpoly') {
    const address = trimmed.split(/\s+/)[1]
    if (!address) return promptForPolymarketAddress()
    if (!isEvmAddress(address)) return promptForPolymarketAddress()
    await context.store.updateUser(context.userId, {
      polymarketAddress: address,
    })
    return {
      text: withFooter([
        `Polymarket wallet saved: ${shortAddress(address)}`,
        'This is used only for public position/value lookup.',
      ]),
    }
  }

  if (cmd === '/setpaid') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    const [, chainRaw, address] = trimmed.split(/\s+/, 3)
    const chain = chainRaw?.toLowerCase()
    if (chain === 'price') {
      const amount = parseUsdcAmount(address)
      if (!amount) return { text: 'Use /setpaid price 1. Amounts must use up to 6 decimals.' }
      await context.store.updatePlatform({ paidAiPriceUsdc: amount })
      return { text: withFooter([`Built-in paid AI default price saved: ${amount} USDC`]) }
    }
    if (chain === 'evm' || chain === 'base' || chain === 'arbitrum') {
      if (!address || !isEvmAddress(address)) return { text: 'Use /setpaid evm 0xYourHashPayLinkWallet.' }
      await context.store.updatePlatform({ evmAddress: address })
      return { text: withFooter([`Built-in paid AI EVM recipient saved: ${shortAddress(address)}`]) }
    }
    if (chain === 'solana' || chain === 'sol') {
      if (!address || !isLikelySolanaAddress(address)) return { text: 'Use /setpaid solana YourSolanaWallet.' }
      await context.store.updatePlatform({ solanaAddress: address })
      return { text: withFooter([`Built-in paid AI Solana recipient saved: ${shortAddress(address)}`]) }
    }
    return { text: 'Use /setpaid evm 0xYourWallet, /setpaid solana YourSolanaWallet, or /setpaid price 1.' }
  }

  if (cmd === '/setlpprice') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    const amount = parseUsdcAmount(trimmed.split(/\s+/)[1])
    if (!amount) return { text: 'Use /setlpprice 1. Amounts must use up to 6 decimals.' }
    await context.store.updatePlatform({ polymarketLpPriceUsdc: amount })
    return { text: withFooter([`Polymarket LP Scout price saved: ${amount} USDC`]) }
  }

  if (cmd === '/paidsettings') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    return { text: paidSettingsText(context.store, config) }
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
    return { text: withFooter([`Default network saved: ${nextNetwork}`, '', 'Future /request commands will use this network unless you add on solana or on arbitrum.']) }
  }

  if (cmd === '/networks') {
    return { text: withFooter(NETWORK_HELP) }
  }

  if (cmd === '/me') {
    return {
      text: withFooter([
        'Your Hash PayLink settings',
        '',
        `Telegram user ID: ${context.userId}`,
        `EVM: ${shortAddress(profile.evmAddress)}`,
        `Solana: ${shortAddress(profile.solanaAddress)}`,
        `Polymarket: ${shortAddress(profile.polymarketAddress)}`,
        `Email alerts: ${profile.polymarketEmailAlertsEnabled ? profile.email ?? 'on, email missing' : 'off'}`,
        `Default network: ${userNetwork(profile, config)}`,
        `Recent requests: ${profile.recentRequests?.length ?? 0}`,
        `AI access requests: ${profile.recentAiRequests?.length ?? 0}`,
        `Recent streams: ${profile.recentStreams?.length ?? 0}`,
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

  if (cmd === '/poly' || cmd === '/positions') {
    return formatPolymarketPortfolio(profile)
  }

  if (cmd === '/setemail' || cmd === '/setmail') {
    const email = trimmed.split(/\s+/)[1]?.toLowerCase()
    if (!email || !isEmail(email)) {
      return {
        text: withFooter([
          'Add the email address for Polymarket risk alerts.',
          '',
          'Example:',
          '/setemail you@example.com',
        ]),
      }
    }
    await context.store.updateUser(context.userId, { email })
    return {
      text: withFooter([
        `Email saved: ${email}`,
        '',
        'Turn on Polymarket downside alerts with:',
        '/polyalerts on',
      ]),
    }
  }

  if (cmd === '/polyalerts') {
    const action = trimmed.split(/\s+/)[1]?.toLowerCase()
    if (!action || action === 'status') {
      return { text: withFooter(formatPolymarketAlertStatus(profile, config).split('\n')) }
    }
    if (action === 'on') {
      if (!profile.polymarketAddress) return promptForPolymarketAddress()
      if (!profile.email) {
        return {
          text: withFooter([
            'Save an email address first.',
            '',
            'Example:',
            '/setemail you@example.com',
          ]),
        }
      }
      await context.store.updateUser(context.userId, { polymarketEmailAlertsEnabled: true })
      return {
        text: withFooter([
          'Polymarket email alerts enabled.',
          '',
          `Email: ${profile.email}`,
          'Trigger: any unresolved open position at or below -30% PnL.',
          'Resolved winning positions can also send a notice.',
          '',
          'Run /polyalerts check to test the watcher now.',
        ]),
      }
    }
    if (action === 'off') {
      await context.store.updateUser(context.userId, { polymarketEmailAlertsEnabled: false })
      return { text: withFooter(['Polymarket email alerts disabled.']) }
    }
    if (action === 'check') {
      const checked = await checkPolymarketRisk(profile)
      if (!checked.ok) return { text: checked.error ?? 'Could not check Polymarket alerts right now.' }
      if (!checked.alerts.length && !checked.settlements.length) {
        await context.store.updateUser(context.userId, { polymarketAlertLastCheckedAt: Date.now() })
        return {
          text: withFooter([
            'Polymarket alert check complete.',
            '',
            'No unresolved open positions are currently at or below -30% PnL.',
            'No resolved winning positions were detected.',
          ]),
        }
      }
      const delivery = await sendDuePolymarketAlerts(context.userId, profile, context.store, config)
        .catch(err => ({ sent: 0, checked: true, error: err instanceof Error ? err.message : String(err) }))
      return {
        text: withFooter([
          'Polymarket alert check complete.',
          '',
          `Risk positions: ${checked.alerts.length}`,
          ...checked.alerts.slice(0, 5).flatMap((alert, index) => [
            `${index + 1}. ${alert.title.slice(0, 80)}`,
            `${alert.outcome} - PnL ${alert.percentPnl.toFixed(2)}%`,
          ]),
          checked.settlements.length ? '' : undefined,
          checked.settlements.length ? `Resolved winning positions: ${checked.settlements.length}` : undefined,
          ...checked.settlements.slice(0, 5).flatMap((alert, index) => [
            `${index + 1}. ${alert.title.slice(0, 80)}`,
            `${alert.outcome}${typeof alert.percentPnl === 'number' ? ` - PnL ${alert.percentPnl.toFixed(2)}%` : ''}`,
          ]),
          '',
          'Email result:',
          'error' in delivery
            ? delivery.error
            : delivery.sent > 0
              ? `Sent ${delivery.sent} email message${delivery.sent === 1 ? '' : 's'}.`
              : 'No email sent. Alerts may be disabled, email may be missing, or the 24h alert cooldown is active.',
        ].filter((line): line is string => typeof line === 'string')),
      }
    }
    return { text: 'Use /polyalerts on, /polyalerts off, /polyalerts status, or /polyalerts check.' }
  }

  if (cmd === '/lp') {
    return createPaidLpRequest(trimmed, profile, config, context)
  }

  if (cmd === '/lpmarket') {
    return createPaidLpRequest(trimmed.replace(/^\/lpmarket\b/i, '/lp'), profile, config, context)
  }

  if (cmd === '/askpaid') {
    const parsed = parsePaidQuestionArgs(trimmed, userNetwork(profile, config))
    if ('error' in parsed) return { text: parsed.error }

    const recipient = getPlatformRecipientForNetwork(context.store, config, parsed.network)
    if (!recipient) return { text: `Paid access recipient is not configured for ${parsed.network}. Ask the Hash PayLink admin to set the default recipient wallet.` }
    const amount = parsed.amount || context.store.getPlatform().paidAiPriceUsdc
    if (!amount) return { text: 'Built-in paid AI default price is not set. Ask the Hash PayLink admin to run /setpaid price 1, or include a price like /askpaid 1 USDC your question.' }

    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount,
      memo: 'Hash PayLink Strategy AI access',
      network: parsed.network,
      evmAddress: parsed.network === 'solana' ? context.store.getPlatform().evmAddress ?? config.defaultEvmAddress : recipient,
      solanaAddress: parsed.network === 'solana' ? recipient : context.store.getPlatform().solanaAddress ?? config.defaultSolanaAddress,
      returnUrl: config.telegramReturnUrl,
      kind: 'ai_access',
      question: parsed.question,
    })
    requests.set(request.id, request)
    latestRequestByUser.set(context.userId, request.id)
    await context.store.updateUser(context.userId, {
      latestRequest: request,
      recentAiRequests: [request, ...(profile.recentAiRequests ?? [])].slice(0, 5),
      recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
    })

    return {
      text: withFooter([
        'Paid AI Access created',
        '',
        `Price: ${request.amount} USDC`,
        `Network: ${request.network}`,
        'Agent: Hash PayLink Circle/Arc/Polymarket Strategy AI',
        '',
        'Question:',
        parsed.question,
        '',
        'Pay to unlock the answer.',
        ...paidAccessPayerHint(request),
      ]),
      buttons: answerButtons(request),
    }
  }

  if (cmd === '/answer') {
    const parsed = parseAnswerArgs(trimmed, profile)
    if (parsed.error || !parsed.request || !parsed.payer) return { text: parsed.error ?? 'Use /answer your-name.' }
    return answerPaidAccessRequest(parsed.request, parsed.payer, config, context)
  }

  if (cmd === '/verifyagent') {
    const parsed = parseAgentRegistrationArgs(trimmed)
    if ('error' in parsed) return { text: parsed.error }
    const existing = context.store.getAgent(parsed.slug)
    if (existing && existing.ownerUserId !== context.userId) {
      return { text: `Agent name "${parsed.slug}" is already registered.` }
    }

    const verified = await verifyAgentEndpoint(parsed, context.userId)
    if ('error' in verified) return { text: verified.error }
    await context.store.upsertAgent(verified)
    return {
      text: withFooter([
        'Agent verified on Hash PayLink.',
        '',
        `Name: ${verified.slug}`,
        `One-time price: ${verified.priceUsdc} USDC`,
        `Endpoint: ${verified.endpointUrl}`,
        '',
        'Users can now call:',
        `/askagent ${verified.slug} your question`,
        '',
        'Circle Agent Stack wallet:',
        `/agentwalletsetup ${verified.slug}`,
        '',
        'Optional streaming retainer:',
        `/setagentstream ${verified.slug} 25 7d`,
      ]),
    }
  }

  if (cmd === '/agentwalletsetup') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1])
    if (!slug) return { text: 'Use /agentwalletsetup agent-name.' }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.ownerUserId !== context.userId) return { text: `Only the owner of "${slug}" can provision its Agent Wallet.` }
    return { text: agentWalletSetupText(agent) }
  }

  if (cmd === '/setagentwallet') {
    const [, slugRaw, address] = trimmed.split(/\s+/, 3)
    const slug = normalizeAgentSlug(slugRaw)
    if (!slug || !address || !isEvmAddress(address)) {
      return { text: 'Use /setagentwallet agent-name 0xCircleAgentWallet.' }
    }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.ownerUserId !== context.userId) return { text: `Only the owner of "${slug}" can update its Agent Wallet.` }
    const updated = { ...agent, agentWalletAddress: address, agentWalletChain: 'arc-testnet' as const }
    await context.store.upsertAgent(updated)
    return {
      text: withFooter([
        'Circle Agent Wallet saved.',
        '',
        `Agent: ${updated.slug}`,
        `Wallet: ${shortAddress(updated.agentWalletAddress)}`,
        'Chain: Arc testnet',
        '',
        'One-time /askagent and StreamPay /streamagent payments will prefer this agent wallet.',
      ]),
    }
  }

  if (cmd === '/setagentprice') {
    const parts = trimmed.split(/\s+/)
    const slug = normalizeAgentSlug(parts[1])
    const priceUsdc = parseUsdcAmount(parts[2])
    if (!slug || !priceUsdc) return { text: 'Use /setagentprice agent-name 2.' }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.ownerUserId !== context.userId) return { text: `Only the owner of "${slug}" can update its default price.` }
    const updated = { ...agent, priceUsdc }
    await context.store.upsertAgent(updated)
    return {
      text: withFooter([
        'Agent default price updated.',
        '',
        `Name: ${updated.slug}`,
        `Price: ${updated.priceUsdc} USDC`,
      ]),
    }
  }

  if (cmd === '/setagentstream') {
    const parts = trimmed.split(/\s+/)
    const slug = normalizeAgentSlug(parts[1])
    const amount = parseUsdcAmount(parts[2])
    const duration = parts[3]?.toLowerCase()
    if (!slug || !amount || !duration || !/^\d+[dhw]$/.test(duration)) {
      return { text: 'Use /setagentstream agent-name 25 7d.' }
    }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.ownerUserId !== context.userId) return { text: `Only the owner of "${slug}" can update its streaming retainer.` }
    const updated = { ...agent, streamPriceUsdc: amount, streamDuration: duration }
    await context.store.upsertAgent(updated)
    return {
      text: withFooter([
        'Agent streaming retainer updated.',
        '',
        `Name: ${updated.slug}`,
        `One-time access: ${updated.priceUsdc} USDC`,
        `Streaming retainer: ${updated.streamPriceUsdc} USDC for ${updated.streamDuration}`,
        '',
        `Users can now call: /streamagent ${updated.slug}`,
      ]),
    }
  }

  if (cmd === '/agents') {
    const agents = context.store.listAgents().filter(agent => agent.status === 'active').slice(0, 10)
    if (!agents.length) return { text: 'No verified Hash PayLink agents yet.' }
    return {
      text: withFooter([
        'Verified Hash PayLink agents',
        '',
        ...agents.flatMap(agent => [
          `${agent.slug}`,
          `Agent Wallet: ${agent.agentWalletAddress ? shortAddress(agent.agentWalletAddress) : 'not set'}`,
          `One-time: ${agent.priceUsdc} USDC`,
          `/askagent ${agent.slug} your question`,
          agent.streamPriceUsdc && agent.streamDuration
            ? `Stream: ${agent.streamPriceUsdc} USDC for ${agent.streamDuration}`
            : 'Stream: not set',
          agent.streamPriceUsdc && agent.streamDuration
            ? `/streamagent ${agent.slug}`
            : '',
          '',
        ]).filter(Boolean).slice(0, -1),
      ]),
    }
  }

  if (cmd === '/askagent') {
    const parts = trimmed.split(/\s+/)
    const slug = normalizeAgentSlug(parts[1])
    if (!slug) return { text: 'Use /askagent agent-name your question.' }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.status !== 'active') return { text: `Agent "${slug}" is not active.` }
    const question = parts.slice(2).join(' ').trim()
    if (!question) return { text: `Ask a question after the agent name. Example: /askagent ${slug} Analyze BTC risk.` }
    if (question.length > MAX_QUESTION_LENGTH) return { text: `Question is too long. Keep it under ${MAX_QUESTION_LENGTH} characters.` }

    const network = userNetwork(profile, config)
    const recipient = getAgentOwnerRecipientForNetwork(agent, context.store, config, network)
    if (!recipient) return { text: `Agent "${slug}" has no recipient wallet configured for ${network}. Ask the agent owner to set their wallet.` }
    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: agent.priceUsdc,
      memo: `Agent access: ${agent.slug}`,
      network,
      evmAddress: network === 'solana' ? config.defaultEvmAddress : recipient,
      solanaAddress: network === 'solana' ? recipient : config.defaultSolanaAddress,
      returnUrl: config.telegramReturnUrl,
      kind: 'agent_access',
      question,
      agentSlug: agent.slug,
    })
    requests.set(request.id, request)
    latestRequestByUser.set(context.userId, request.id)
    await context.store.updateUser(context.userId, {
      latestRequest: request,
      recentAiRequests: [request, ...(profile.recentAiRequests ?? [])].slice(0, 5),
      recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
    })

    return {
      text: withFooter([
        `Verified Hash PayLink agent: ${agent.slug}`,
        '',
        `Price: ${agent.priceUsdc} USDC`,
        `Network: ${network}`,
        '',
        'Payment required before access.',
        'Proceed to payment.',
        '',
        ...paidAccessPayerHint(request),
      ]),
      buttons: answerButtons(request),
    }
  }

  if (cmd === '/streamagent') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1])
    if (!slug) return { text: 'Use /streamagent agent-name 25 USDC for 7d reason="monitoring retainer".' }
    const agent = context.store.getAgent(slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (agent.status !== 'active') return { text: `Agent "${slug}" is not active.` }

    const parsed = parseAgentStreamArgs(trimmed, agent)
    if ('error' in parsed) return { text: parsed.error }
    const ownerProfile = context.store.getUser(agent.ownerUserId)
    const recipient = agent.agentWalletAddress ?? ownerProfile.evmAddress
    if (!recipient) {
      return { text: `Agent "${agent.slug}" has no Circle Agent Wallet configured. Ask the owner to run /agentwalletsetup ${agent.slug}, then /setagentwallet ${agent.slug} 0xAgentWallet.` }
    }

    const stream = buildStreamRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.amount,
      recipient,
      duration: parsed.duration,
      reason: parsed.reason,
    })
    await context.store.updateUser(context.userId, {
      recentStreams: [stream, ...(profile.recentStreams ?? [])].slice(0, 5),
    })
    return {
      text: withFooter([
        'Agent StreamPay retainer created',
        '',
        `Agent: ${agent.slug}`,
        `${stream.amount} USDC for ${stream.duration}`,
        `Recipient: ${shortAddress(stream.recipient)}`,
        `Reason: ${stream.reason}`,
        '',
        'This is an Arc testnet StreamPay retainer. Open StreamPay to fund and deploy the USDC stream.',
      ]),
      buttons: [{ text: 'Open StreamPay', url: stream.streamUrl }],
    }
  }

  if (cmd === '/stream') {
    const parsed = parseStreamArgs(trimmed)
    if ('error' in parsed) return { text: parsed.error }

    if (parsed.recipientKind === 'email') {
      const resolved = await resolveCircleRecipientWallet(config.hashPayLinkBaseUrl, parsed.recipient)
      if ('error' in resolved) return { text: resolved.error }
      if (!resolved.found) {
        const pending = buildPendingStreamRequest({
          baseUrl: config.hashPayLinkBaseUrl,
          amount: parsed.amount,
          recipientEmail: parsed.recipient,
          duration: parsed.duration,
          reason: parsed.reason,
        })
        await context.store.updateUser(context.userId, {
          pendingStreams: [pending, ...(profile.pendingStreams ?? [])].slice(0, 5),
        })
        return {
          text: withFooter([
            'Recipient Circle wallet setup required',
            '',
            `${pending.amount} USDC`,
            `Recipient: ${pending.recipientEmail}`,
            `Duration: ${pending.duration}`,
            `Reason: ${pending.reason}`,
            '',
            'Share the setup link with the recipient.',
            'After they prepare their Circle Smart Wallet, run:',
            `/streamready ${pending.id}`,
          ]),
          buttons: [{ text: 'Prepare Recipient Wallet', url: pending.prepareUrl }],
        }
      }

      const stream = buildStreamRequest({
        baseUrl: config.hashPayLinkBaseUrl,
        amount: parsed.amount,
        recipient: resolved.walletAddress,
        duration: parsed.duration,
        reason: parsed.reason,
      })
      await context.store.updateUser(context.userId, {
        recentStreams: [stream, ...(profile.recentStreams ?? [])].slice(0, 5),
      })
      return {
        text: withFooter([
          'Arc StreamPay link created',
          '',
          `${stream.amount} USDC`,
          `Recipient email: ${parsed.recipient}`,
          `Circle wallet: ${shortAddress(stream.recipient)}`,
          `Duration: ${stream.duration}`,
          `Reason: ${stream.reason}`,
          '',
          'Open StreamPay to fund and deploy the Arc USDC stream.',
        ]),
        buttons: [{ text: 'Open StreamPay', url: stream.streamUrl }],
      }
    }

    const stream = buildStreamRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.amount,
      recipient: parsed.recipient,
      duration: parsed.duration,
      reason: parsed.reason,
    })
    await context.store.updateUser(context.userId, {
      recentStreams: [stream, ...(profile.recentStreams ?? [])].slice(0, 5),
    })
    return {
      text: withFooter([
        'Arc StreamPay link created',
        '',
        `${stream.amount} USDC`,
        `Recipient: ${shortAddress(stream.recipient)}`,
        `Duration: ${stream.duration}`,
        `Reason: ${stream.reason}`,
        '',
        'Open StreamPay to fund and deploy the Arc USDC stream.',
      ]),
      buttons: [{ text: 'Open StreamPay', url: stream.streamUrl }],
    }
  }

  if (cmd === '/streamready') {
    const pendingId = trimmed.split(/\s+/)[1]
    const pending = findPendingStream(pendingId, profile)
    if (!pending) return { text: 'Pending stream not found. Use /streams to see recent pending streams.' }
    const resolved = await resolveCircleRecipientWallet(config.hashPayLinkBaseUrl, pending.recipientEmail)
    if ('error' in resolved) return { text: resolved.error }
    if (!resolved.found) {
      return {
        text: withFooter([
          'Recipient wallet is not ready yet.',
          '',
          `Recipient: ${pending.recipientEmail}`,
          '',
          'Ask the recipient to open the setup link and prepare their Circle Smart Wallet.',
        ]),
        buttons: [{ text: 'Prepare Recipient Wallet', url: pending.prepareUrl }],
      }
    }

    const stream = buildStreamRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: pending.amount,
      recipient: resolved.walletAddress,
      duration: pending.duration,
      reason: pending.reason,
    })
    await context.store.updateUser(context.userId, {
      recentStreams: [stream, ...(profile.recentStreams ?? [])].slice(0, 5),
      pendingStreams: (profile.pendingStreams ?? []).filter(item => item.id !== pending.id),
    })
    return {
      text: withFooter([
        'Recipient Circle wallet resolved',
        '',
        `${stream.amount} USDC`,
        `Recipient email: ${pending.recipientEmail}`,
        `Circle wallet: ${shortAddress(stream.recipient)}`,
        `Duration: ${stream.duration}`,
        `Reason: ${stream.reason}`,
        '',
        'Open StreamPay to fund and deploy the Arc USDC stream.',
      ]),
      buttons: [{ text: 'Open StreamPay', url: stream.streamUrl }],
    }
  }

  if (cmd === '/streams') {
    const streams = profile.recentStreams ?? []
    const pending = profile.pendingStreams ?? []
    if (!streams.length && !pending.length) return { text: 'No recent streams found. Create one with /stream 100 USDC to 0xRecipient for 7d.' }
    return {
      text: withFooter([
        'Recent Arc streams',
        '',
        ...streams.flatMap((stream: StreamRequest, index: number) => [
          `${index + 1}. ${stream.amount} USDC for ${stream.duration}`,
          stream.reason,
          `Recipient: ${shortAddress(stream.recipient)}`,
          `ID: ${stream.id}`,
          '',
        ]),
        pending.length ? 'Pending recipient wallets' : '',
        ...pending.flatMap((stream: PendingStreamRequest, index: number) => [
          `${index + 1}. ${stream.amount} USDC for ${stream.duration}`,
          stream.reason,
          `Recipient: ${stream.recipientEmail}`,
          `Ready check: /streamready ${stream.id}`,
          '',
        ]),
      ].filter(Boolean).slice(0, -1),
      ),
      buttonRows: [
        ...streams.map((stream, index) => [
          { text: `Open ${index + 1}`, url: stream.streamUrl },
        ]),
        ...pending.map((stream, index) => [
          { text: `Prepare ${index + 1}`, url: stream.prepareUrl },
        ]),
      ],
    }
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
