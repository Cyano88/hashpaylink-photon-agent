import type { AppConfig, Network } from './config.js'
import { formatCliCommand, runCircleCli } from './circleCli.js'
import { checkPolymarketRisk, formatPolymarketAlertStatus, sendDuePolymarketAlerts } from './polymarketAlerts.js'
import {
  buildPaymentRequest,
  buildPendingStreamRequest,
  buildStreamRequest,
  createRequestId,
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
const FOOTER = '      Powered by Hash PayLink'
const MAX_USDC_WHOLE_DIGITS = 12
const POLYMARKET_MIN_FUNDING_USDC = 4
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
const POLYMARKET_AUTOPILOT_TEST_CAP_USDC = 5
const POLYMARKET_AUTOPILOT_STOP_LOSS_PERCENT = 30

const HELP_LINES = [
  'Hash PayLink',
  '',
  'USDC payments and agent commerce from Telegram.',
  '',
  '/pay - create payment links',
  '/stream - StreamPay on Arc',
  '/agent - buyer and seller agents',
  '/polymarket - LP Scout and daily reports',
  '/settings - saved wallets and defaults',
]

const PAYMENTS_HELP_LINES = [
  'Payments',
  '',
  '/request 10 USDC for design - create link',
  '/status - check latest link',
  '/remind - resend latest link',
  '/requests - recent links',
  '/answer payer-name - unlock paid answer',
  '',
  '/network base - set default network',
]

const STREAMPAY_HELP_LINES = [
  'StreamPay',
  '',
  '/stream 10 USDC to 0xWallet for 7d - new stream',
  '/stream 10 USDC to email@example.com for 7d - stream to email',
  '/streams - running and recent streams',
  '/streamready pending-id - check email wallet',
  '',
  'Streams run on Arc with Circle Smart Wallet.',
]

const POLYMARKET_HELP_LINES = [
  'Polymarket',
  '',
  '/lp x402 buyer-agent - one-time LP Scout',
  '/agenticstream 7d you@example.com - daily LP reports',
  '/poly - view saved public positions',
  '',
  'Optional watchlist:',
  '/setpoly 0xPublicWallet',
  '/polyalerts on',
]

const LP_HELP_LINES = [
  'LP Scout',
  '',
  '/lp best - create paid LP report link',
  '/lp crypto - search crypto markets',
  '/lpmarket polymarket-url-or-slug - inspect one market',
  '/lp x402 buyer-agent - buyer agent buys live LP data',
  '',
  'Agentic streaming:',
  '/agenticstream 7d you@example.com - stream daily LP research',
]

const AGENT_HELP_LINES = [
  'Agents',
  '',
  '/buyeragent - buy services',
  '/selleragent - sell services',
  '/agent hashpaylink-agent - open dashboard',
  '/agents - seller directory',
  '',
  'Seller receives USDC. Buyer spends USDC.',
]

const SELLER_AGENT_HELP_LINES = [
  'Seller agents',
  '',
  '/registeragent agent-name agent-url price - sell a service',
  '/setagentwallet agent-name 0xWallet - set receiving wallet',
  '/setagentprice agent-name 1 - set ask price',
  '/setagentstream agent-name 25 7d - set stream price',
  '/agent agent-name - open seller dashboard',
  '/agents - list seller agents',
  '',
  'Example:',
  '/buyagent hashpaylink-agent Analyze LP rewards',
]

const BUYER_AGENT_HELP_LINES = [
  'Buyer agents',
  '',
  '/createbuyerwallet buyer-agent - connect buyer wallet',
  '/buyer buyer-agent - open buyer dashboard',
  '/fundagent buyer-agent 10 USDC on base - fund buyer wallet',
  '/buyagent hashpaylink-agent your question - buy from seller',
  '/lp x402 buyer-agent - buyer pays x402 LP API',
  '',
  'Note:',
  'x402 needs Gateway funds. Normal tips do not.',
]

const SETTINGS_HELP_LINES = [
  'Settings',
  '',
  '/me - view saved profile',
  '/setevm 0xWallet - save EVM wallet',
  '/setsol SolanaWallet - save Solana wallet',
  '/network base - set default network',
  '/network arbitrum - set default network',
  '/network solana - set default network',
  '/setpaid evm 0xWallet - admin paid AI wallet',
  '/setpaid price 1 - admin paid AI price',
  '/setlpprice 1 - admin LP price',
  '/paidsettings - view paid settings',
  '/clear - clear saved bot messages',
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

type ParsedAgenticStreamArgs =
  | { days: number; duration: string; totalAmount: string; amountPerDay: string; reportEmail: string }
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

function compactUrl(raw: string) {
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    return url.toString().replace(/^https?:\/\/(www\.)?/, '')
  } catch {
    return raw
  }
}

function compactPolymarketUrl(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  return compactUrl(raw.trim())
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

function isBelowPolymarketFundingMinimum(amount: string | undefined) {
  return !!amount && Number(amount) < POLYMARKET_MIN_FUNDING_USDC
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
    return { error: 'Use /registeragent agent-name https://api.example.com/ask 2' }
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

function formatUsdcDecimal(value: number) {
  return value.toFixed(6).replace(/\.?0+$/, '')
}

function parseAgenticStreamArgs(text: string, profile: UserProfile): ParsedAgenticStreamArgs {
  const parts = text.trim().split(/\s+/).slice(1)
  const amountPerDay = '0.01'
  let days = 7
  let reportEmail = profile.email ?? ''

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (/^\d+d$/.test(lower)) {
      days = Number(lower.slice(0, -1))
      continue
    }
    if (/^\d+$/.test(lower)) {
      days = Number(lower)
      continue
    }
    if (isEmail(part)) reportEmail = part.toLowerCase()
  }

  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return { error: 'Use /agenticstream 7d you@example.com. Duration must be 1d to 30d.' }
  }
  if (!reportEmail || !isEmail(reportEmail)) {
    return { error: 'Use /agenticstream 7d you@example.com, or save an email first with /setemail you@example.com.' }
  }

  return {
    days,
    duration: `${days}d`,
    amountPerDay,
    totalAmount: formatUsdcDecimal(Number(amountPerDay) * days),
    reportEmail,
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
      'This is the 0x address from your Polymarket profile. It is used only for public portfolio lookup, watchlist, and alerts.',
    ]),
    forceReplyPlaceholder: '0xPublicPolymarketWallet',
  }
}

function promptForPolymarketFundingAddress(): CommandResult {
  return {
    text: withFooter([
      'Paste the wallet that should receive Polymarket funding.',
      '',
      'This can be your Polymarket deposit wallet or another EVM wallet you want funded through Hash PayLink.',
    ]),
    forceReplyPlaceholder: '0xFundingWallet',
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

function defaultAgent(config: AppConfig): AgentRegistration {
  return {
    slug: config.defaultAgentSlug,
    role: 'seller',
    endpointUrl: config.defaultAgentEndpointUrl,
    priceUsdc: config.defaultAgentPriceUsdc,
    streamPriceUsdc: config.defaultAgentStreamPriceUsdc,
    streamDuration: config.defaultAgentStreamDuration,
    agentWalletAddress: config.defaultAgentWalletAddress || undefined,
    agentWalletChain: config.defaultAgentWalletAddress ? 'arc-testnet' : undefined,
    ownerUserId: 'platform',
    status: 'active',
    createdAt: 0,
    verifiedAt: 0,
  }
}

function buyerAgent(slug: string, userId: string, config: AppConfig): AgentRegistration {
  return {
    slug,
    role: 'buyer',
    endpointUrl: config.defaultAgentEndpointUrl,
    priceUsdc: '0',
    ownerUserId: userId,
    status: 'active',
    createdAt: Date.now(),
    verifiedAt: Date.now(),
  }
}

function getAgent(store: ProfileStore, config: AppConfig, slug: string) {
  return store.getAgent(slug) ?? (slug === config.defaultAgentSlug ? defaultAgent(config) : undefined)
}

async function hydrateAgentWallet(agent: AgentRegistration, config: AppConfig): Promise<AgentRegistration> {
  if (agent.agentWalletAddress || !config.agentWalletLookupEnabled) return agent
  try {
    const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
    const response = await fetch(`${base}/api/agent-wallet?agent=${encodeURIComponent(agent.slug)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    })
    const data = await response.json().catch(() => undefined) as { ok?: boolean; found?: boolean; walletAddress?: string } | undefined
    if (response.ok && data?.ok && data.found && data.walletAddress && isEvmAddress(data.walletAddress)) {
      return { ...agent, agentWalletAddress: data.walletAddress, agentWalletChain: 'arc-testnet' }
    }
  } catch {
    // Wallet lookup is best-effort; local registered data remains the source of truth.
  }
  return agent
}

function listAgents(store: ProfileStore, config: AppConfig) {
  const agents = store.listAgents()
  if (!agents.some(agent => agent.slug === config.defaultAgentSlug)) {
    agents.unshift(defaultAgent(config))
  }
  return agents
}

function canManageAgent(agent: AgentRegistration, config: AppConfig, userId: string) {
  return agent.ownerUserId === userId || (agent.ownerUserId === 'platform' && isAdmin(config, userId))
}

function isSafeChain(value: string | undefined) {
  return !!value && /^[A-Z0-9-]{2,32}$/.test(value)
}

function isSafeToken(value: string | undefined) {
  return !!value && /^[A-Z0-9-]{2,16}$/.test(value)
}

function resolveAgentWalletTarget(raw: string | undefined, store: ProfileStore, config: AppConfig) {
  if (!raw) return undefined
  if (isEvmAddress(raw)) return raw
  const slug = normalizeAgentSlug(raw)
  if (!slug) return undefined
  return getAgent(store, config, slug)?.agentWalletAddress
}

function parseCircleRequestId(output: string) {
  const explicit = output.match(/request(?:\s|-)?id[^a-zA-Z0-9_-]+([a-zA-Z0-9_-]{8,})/i)?.[1]
  if (explicit) return explicit
  return output.match(/\b[a-f0-9]{8,}(?:-[a-f0-9]{4,}){2,}\b/i)?.[0]
}

function parseCircleWalletAddress(output: string) {
  try {
    const parsed = JSON.parse(output) as unknown
    const queue = [parsed]
    while (queue.length) {
      const item = queue.shift()
      if (!item) continue
      if (typeof item === 'string' && isEvmAddress(item)) return item
      if (Array.isArray(item)) queue.push(...item)
      if (typeof item === 'object') queue.push(...Object.values(item as Record<string, unknown>))
    }
  } catch {
    // Fall through to text parsing; Circle CLI text output is still useful for humans.
  }
  return output.match(/0x[a-fA-F0-9]{40}/)?.[0]
}

function circleSessionKey(userId: string, agentSlug: string) {
  return `${userId}_${agentSlug}`
}

function circleWalletHelp(config: AppConfig) {
  return withFooter([
    'Circle Agent Wallet CLI',
    '',
    `Execution: ${config.circleCliEnabled ? 'enabled' : 'disabled'}`,
    `Spending commands: ${config.circleCliSpendingEnabled ? 'enabled' : 'disabled'}`,
    '',
    'Setup:',
    '/circlewallet login you@example.com testnet',
    '/circlewallet list ARC-TESTNET',
    '',
    'Read:',
    '/circlewallet balance hashpaylink-agent ARC-TESTNET',
    '',
    'Fund:',
    '/circlewallet fund hashpaylink-agent ARC-TESTNET',
    '',
    'Spending command previews:',
    '/circlewallet transfer hashpaylink-agent 1 0xRecipient ARC-TESTNET',
    '/circlewallet bridge hashpaylink-agent 1 ARC-TESTNET BASE-SEPOLIA',
    '/circlewallet swap hashpaylink-agent EURC 10 USDC 9.9 BASE',
  ])
}

function buildAgentFundingRequest(agent: AgentRegistration, amount: string, network: Network, config: AppConfig) {
  if (!agent.agentWalletAddress) return undefined
  if (network === 'solana') return undefined
  return buildPaymentRequest({
    baseUrl: config.hashPayLinkBaseUrl,
    amount,
    memo: `Fund agent wallet: ${agent.slug}`,
    network,
    evmAddress: agent.agentWalletAddress,
    solanaAddress: config.defaultSolanaAddress,
    returnUrl: config.telegramReturnUrl,
    kind: 'agent_funding',
    agentSlug: agent.slug,
  })
}

function buildPolymarketFundingRequest(profile: UserProfile, amount: string | undefined, network: Network, config: AppConfig): PaymentRequest | undefined {
  if (!profile.polymarketFundingAddress) return undefined
  if (network === 'solana') return undefined

  const id = createRequestId()
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('id', id)
  params.set('m', 'Polymarket')
  params.set('n', network)
  params.set('src', 't')
  params.set('brand', 'polymarket')
  params.set('pm', '1')
  if (amount) params.set('a', amount)
  else params.set('f', '1')
  if (config.telegramReturnUrl) params.set('r', config.telegramReturnUrl)
  params.set('e', profile.polymarketFundingAddress)
  if (config.defaultSolanaAddress) params.set('s', config.defaultSolanaAddress)

  return {
    amount: amount ?? 'open',
    memo: 'Polymarket',
    network,
    kind: 'collection',
    id,
    payUrl: `${base}/pay?${params.toString()}`,
    dashboardUrl: `${base}/dashboard?${params.toString()}`,
  }
}

function buildAgentStreamRequest(agent: AgentRegistration, config: AppConfig) {
  if (!agent.agentWalletAddress || !agent.streamPriceUsdc || !agent.streamDuration) return undefined
  return buildStreamRequest({
    baseUrl: config.hashPayLinkBaseUrl,
    amount: agent.streamPriceUsdc,
    recipient: agent.agentWalletAddress,
    duration: agent.streamDuration,
    reason: `Agent retainer: ${agent.slug}`,
  })
}

function buildAgentProfileUrl(agent: AgentRegistration, config: AppConfig) {
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('profile', 'agent')
  params.set('agent', agent.slug)
  params.set('price', agent.priceUsdc)
  params.set('fund', '10')
  params.set('n', 'base')
  if (agent.agentWalletAddress) params.set('wallet', agent.agentWalletAddress)
  if (agent.streamPriceUsdc) params.set('streamPrice', agent.streamPriceUsdc)
  if (agent.streamDuration) params.set('streamDuration', agent.streamDuration)
  return `${base}/agent?${params.toString()}`
}

function buildAgentWalletSetupUrl(slug: string, config: AppConfig) {
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('profile', 'agent')
  params.set('agent', slug)
  params.set('price', config.defaultAgentPriceUsdc)
  params.set('fund', '10')
  params.set('n', 'arc')
  return `${base}/agent?${params.toString()}`
}

function buildTelegramAgentLauncherUrl(config: AppConfig, userId: string) {
  const base = config.hashPayLinkBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams({
    open: '1',
    section: 'agent-wallets',
    service: 'hashpaylink-agent',
    telegramId: userId,
  })
  return `${base}/telegram/payment-links?${params.toString()}`
}

function agentDashboard(agent: AgentRegistration, config: AppConfig): CommandResult {
  const funding = buildAgentFundingRequest(agent, '10', 'base', config)
  const stream = buildAgentStreamRequest(agent, config)
  const buttonRows: CommandResult['buttonRows'] = []
  buttonRows.push([{ text: 'Open Agent Dashboard', url: buildAgentProfileUrl(agent, config) }])
  if (funding) buttonRows.push([{ text: 'Fund Agent Wallet', url: funding.payUrl }])
  if (stream) buttonRows.push([{ text: 'Start StreamPay Retainer', url: stream.streamUrl }])

  return {
    text: withFooter([
      'Hash PayLink Agent',
      '',
      `Agent: ${agent.slug}`,
      `Wallet: ${agent.agentWalletAddress ? shortAddress(agent.agentWalletAddress) : 'not connected'}`,
      '',
      `Ask once: ${agent.priceUsdc} USDC`,
      agent.streamPriceUsdc && agent.streamDuration
        ? `Stream: ${agent.streamPriceUsdc} USDC for ${agent.streamDuration}`
        : 'Stream: dashboard setup',
      '',
      agent.agentWalletAddress
        ? 'Use the buttons below to fund, stream, or manage.'
        : 'Open dashboard to connect the Circle Agent Wallet.',
    ]),
    buttonRows: buttonRows.length ? buttonRows : undefined,
  }
}

async function formatCircleCliResponse(config: AppConfig, args: string[], execute: boolean, spending: boolean) {
  const command = formatCliCommand(args)
  if (!execute || !config.circleCliEnabled || (spending && !config.circleCliSpendingEnabled)) {
    return withFooter([
      spending && !config.circleCliSpendingEnabled
        ? 'Circle CLI spending execution is disabled. Review and run manually:'
        : config.circleCliEnabled
          ? 'Circle CLI command preview:'
          : 'Circle CLI execution is disabled. Run manually:',
      '',
      command,
    ])
  }

  const result = await runCircleCli(args)
  return withFooter([
    result.ok ? 'Circle CLI result' : 'Circle CLI error',
    '',
    command,
    '',
    result.output.slice(0, 3000),
  ])
}

async function handleCircleWalletCommand(trimmed: string, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const parts = trimmed.split(/\s+/)
  const action = parts[1]?.toLowerCase()
  if (!action || action === 'help') return { text: circleWalletHelp(config) }

  if (action === 'login') {
    const email = parts[2]?.toLowerCase()
    if (!email || !isEmail(email)) return { text: 'Use /circlewallet login you@example.com testnet.' }
    const testnet = parts.includes('testnet') || parts.includes('--testnet')
    return {
      text: await formatCircleCliResponse(config, ['wallet', 'login', email, ...(testnet ? ['--testnet'] : [])], false, false),
    }
  }

  if (action === 'list') {
    const chain = (parts[2] ?? 'ARC-TESTNET').toUpperCase()
    if (!isSafeChain(chain)) return { text: 'Use /circlewallet list ARC-TESTNET.' }
    return {
      text: await formatCircleCliResponse(config, ['wallet', 'list', '--type', 'agent', '--chain', chain], true, false),
    }
  }

  if (action === 'balance') {
    const address = resolveAgentWalletTarget(parts[2] ?? config.defaultAgentSlug, context.store, config)
    const chain = (parts[3] ?? 'ARC-TESTNET').toUpperCase()
    if (!address || !isSafeChain(chain)) return { text: 'Use /circlewallet balance hashpaylink-agent ARC-TESTNET.' }
    return {
      text: await formatCircleCliResponse(config, ['wallet', 'balance', '--address', address, '--chain', chain], true, false),
    }
  }

  if (action === 'fund') {
    const address = resolveAgentWalletTarget(parts[2] ?? config.defaultAgentSlug, context.store, config)
    const chain = (parts[3] ?? 'ARC-TESTNET').toUpperCase()
    if (!address || !isSafeChain(chain)) return { text: 'Use /circlewallet fund hashpaylink-agent ARC-TESTNET.' }
    const args = chain.includes('TESTNET')
      ? ['wallet', 'fund', '--address', address, '--chain', chain]
      : ['wallet', 'fund', '--address', address, '--chain', chain, '--amount', parts[4] ?? '10', '--method', 'crypto']
    return { text: await formatCircleCliResponse(config, args, chain.includes('TESTNET'), true) }
  }

  if (action === 'transfer') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    const address = resolveAgentWalletTarget(parts[2], context.store, config)
    const amount = parseUsdcAmount(parts[3])
    const recipient = parts[4]
    const chain = (parts[5] ?? 'ARC-TESTNET').toUpperCase()
    if (!address || !amount || !recipient || !isEvmAddress(recipient) || !isSafeChain(chain)) {
      return { text: 'Use /circlewallet transfer hashpaylink-agent 1 0xRecipient ARC-TESTNET.' }
    }
    return {
      text: await formatCircleCliResponse(config, ['wallet', 'transfer', '--address', address, '--chain', chain, '--amount', amount, '--to', recipient], true, true),
    }
  }

  if (action === 'bridge') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    const address = resolveAgentWalletTarget(parts[2], context.store, config)
    const amount = parseUsdcAmount(parts[3])
    const fromChain = (parts[4] ?? '').toUpperCase()
    const toChain = (parts[5] ?? '').toUpperCase()
    if (!address || !amount || !isSafeChain(fromChain) || !isSafeChain(toChain)) {
      return { text: 'Use /circlewallet bridge hashpaylink-agent 1 ARC-TESTNET BASE-SEPOLIA.' }
    }
    return {
      text: await formatCircleCliResponse(config, ['bridge', 'transfer', toChain, '--amount', amount, '--address', address, '--chain', fromChain], true, true),
    }
  }

  if (action === 'swap') {
    if (!isAdmin(config, context.userId)) return { text: adminRequiredText() }
    const address = resolveAgentWalletTarget(parts[2], context.store, config)
    const sellToken = parts[3]?.toUpperCase()
    const sellAmount = parseUsdcAmount(parts[4])
    const buyToken = parts[5]?.toUpperCase()
    const buyMin = parseUsdcAmount(parts[6])
    const chain = (parts[7] ?? 'BASE').toUpperCase()
    if (!address || !isSafeToken(sellToken) || !sellAmount || !isSafeToken(buyToken) || !buyMin || !isSafeChain(chain)) {
      return { text: 'Use /circlewallet swap hashpaylink-agent EURC 10 USDC 9.9 BASE.' }
    }
    return {
      text: await formatCircleCliResponse(config, ['wallet', 'swap', sellToken, sellAmount, buyToken, buyMin, '--address', address, '--chain', chain], true, true),
    }
  }

  return { text: circleWalletHelp(config) }
}

async function handleAgentWalletCommand(trimmed: string, config: AppConfig, context: CommandContext): Promise<CommandResult> {
  const parts = trimmed.split(/\s+/)
  const actionOrSlug = parts[1]?.toLowerCase()
  const profile = context.store.getUser(context.userId)

  if (!actionOrSlug || actionOrSlug === 'help') {
    return {
      text: withFooter([
        'Agent Wallet',
        '',
        'Recommended:',
        '/createagentwallet agent-name',
        '',
        'OTP fallback:',
        '/agentwallet agent-name you@example.com testnet',
        '/agentwallet code OTP-FROM-EMAIL',
      ]),
    }
  }

  if (actionOrSlug === 'code' || actionOrSlug === 'verify') {
    const pending = profile.circleWalletProvisioning
    const otp = parts[actionOrSlug === 'code' ? 2 : 3]
    const slug = actionOrSlug === 'verify' ? normalizeAgentSlug(parts[2]) : pending?.agentSlug
    if (!pending || !pending.requestId || !slug || pending.agentSlug !== slug) {
      return { text: 'Start first with /agentwallet agent-name you@example.com testnet.' }
    }
    if (!otp || !/^[a-zA-Z0-9-]{4,32}$/.test(otp)) return { text: 'Use /agentwallet code OTP-FROM-EMAIL.' }
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (!canManageAgent(agent, config, context.userId)) return { text: 'Only the agent owner can provision this wallet.' }
    if (!config.circleCliEnabled) {
      return {
        text: withFooter([
          'Circle Agent Wallet provisioning is not enabled on this runtime.',
          '',
          'Set CIRCLE_CLI_ENABLED=true and install @circle-fin/cli on Render, then retry.',
        ]),
      }
    }

    const sessionKey = circleSessionKey(context.userId, slug)
    const loginArgs = ['wallet', 'login', '--request', pending.requestId, '--otp', otp, ...(pending.testnet ? ['--testnet'] : [])]
    const login = await runCircleCli(loginArgs, { sessionKey, acceptTerms: true })
    if (!login.ok) {
      return {
        text: withFooter([
          'Circle wallet login failed.',
          '',
          formatCliCommand(loginArgs),
          '',
          login.output.slice(0, 2500),
        ]),
      }
    }

    const chain = pending.testnet ? 'ARC-TESTNET' : 'BASE'
    const listArgs = ['wallet', 'list', '--type', 'agent', '--chain', chain, '--output', 'json']
    const listed = await runCircleCli(listArgs, { sessionKey })
    const walletAddress = listed.ok ? parseCircleWalletAddress(listed.output) : undefined
    if (!walletAddress) {
      return agentWalletSetupResult(agent, config)
    }

    const updated: AgentRegistration = {
      ...agent,
      agentWalletAddress: walletAddress,
      agentWalletChain: pending.testnet ? 'arc-testnet' : agent.agentWalletChain,
    }
    await context.store.upsertAgent(updated)
    await context.store.updateUser(context.userId, { circleWalletProvisioning: undefined })

    return {
      text: withFooter([
        'Circle Agent Wallet connected',
        '',
        `Agent: ${slug}`,
        `Wallet: ${shortAddress(walletAddress)}`,
        `Circle chain checked: ${chain}`,
        '',
        'Next:',
        `/agent ${slug}`,
        `/fundagent ${slug} 10 USDC on base`,
      ]),
      buttonRows: [[{ text: 'Open Agent Dashboard', url: buildAgentProfileUrl(updated, config) }]],
    }
  }

  const slug = normalizeAgentSlug(actionOrSlug)
  const email = parts[2]?.toLowerCase()
  const testnet = parts.includes('testnet') || parts.includes('--testnet')
  if (!slug || !email || !isEmail(email)) return { text: 'Use /agentwallet agent-name you@example.com testnet.' }
  const agent = getAgent(context.store, config, slug)
  if (!agent) return createAgentWalletResult(slug, config)
  if (!canManageAgent(agent, config, context.userId)) return { text: 'Only the agent owner can provision this wallet.' }
  if (!config.circleCliEnabled) {
    return agentWalletSetupResult(agent, config)
  }

  const sessionKey = circleSessionKey(context.userId, slug)
  const initArgs = ['wallet', 'login', email, '--init', ...(testnet ? ['--testnet'] : [])]
  const result = await runCircleCli(initArgs, { sessionKey, acceptTerms: true })
  if (!result.ok) {
    return {
      text: withFooter([
        'Circle Agent Wallet setup could not start.',
        '',
        formatCliCommand(initArgs),
        '',
        result.output.slice(0, 2500),
      ]),
    }
  }

  const requestId = parseCircleRequestId(result.output)
  await context.store.updateUser(context.userId, {
    circleWalletProvisioning: {
      agentSlug: slug,
      email,
      requestId,
      testnet,
      createdAt: Date.now(),
    },
  })

  return {
    text: withFooter([
      'Circle sent an OTP to your email.',
      '',
      `Agent: ${slug}`,
      `Email: ${email}`,
      requestId ? `Request: ${requestId}` : 'Request ID: saved if Circle returned it',
      '',
      'Reply with:',
      '/agentwallet code OTP-FROM-EMAIL',
      '',
      'OTP requests expire after about 10 minutes.',
    ]),
  }
}

function agentWalletSetupResult(agent: AgentRegistration, config: AppConfig): CommandResult {
  return {
    text: withFooter([
      'Connect Agent Wallet',
      '',
      `Agent: ${agent.slug}`,
      '',
      'Use the dashboard to create or reconnect the Circle Agent Wallet.',
      '',
      'Advanced fallback:',
      `/setagentwallet ${agent.slug} 0xWallet`,
    ]),
    buttons: [{ text: 'Open Agent Dashboard', url: buildAgentProfileUrl(agent, config) }],
  }
}

function createAgentWalletResult(slug: string, config: AppConfig): CommandResult {
  return {
    text: withFooter([
      'Create Agent Wallet',
      '',
      `Agent: ${slug}`,
      '',
      'Open the dashboard and connect the Circle Agent Wallet.',
      '',
      'Then register or launch the agent:',
      `/verifyagent ${slug} https://agent.example/ask price=2`,
      `/agent ${slug}`,
    ]),
    buttons: [{ text: 'Open Agent Dashboard', url: buildAgentWalletSetupUrl(slug, config) }],
  }
}

function missingAgentWalletResult(agent: AgentRegistration, config: AppConfig): CommandResult {
  return {
    text: withFooter([
      'Agent wallet not connected',
      '',
      `Agent: ${agent.slug}`,
      '',
      'Open the dashboard to connect the Circle Agent Wallet, then retry.',
    ]),
    buttons: [{ text: 'Open Agent Dashboard', url: buildAgentProfileUrl(agent, config) }],
  }
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
    opportunity.slug ? `Link: polymarket.com/market/${opportunity.slug}` : undefined,
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
      '/setpoly 0xPublicPolymarketWallet',
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

async function runX402LpScout(config: AppConfig, context: CommandContext, rawAgentSlug?: string): Promise<CommandResult> {
  const slug = normalizeAgentSlug(rawAgentSlug) || config.defaultAgentSlug
  const found = getAgent(context.store, config, slug)
  if (!found) return { text: `Agent "${slug}" is not registered.` }
  const agent = await hydrateAgentWallet(found, config)
  if (agent.role !== 'buyer') {
    return {
      text: withFooter([
        'Use a buyer agent for x402 purchases.',
        '',
        `${agent.slug} is a seller/receiver agent.`,
        '',
        'Create or open a buyer wallet:',
        '/createbuyerwallet buyer-agent',
        '/lp x402 buyer-agent',
      ]),
    }
  }
  if (!agent.agentWalletAddress) {
    return {
      text: withFooter([
        'Buyer agent needs a Circle Agent Wallet first.',
        '',
        'Human pay model:',
        'Human pays agent. Agent answers.',
        '',
        'x402 model:',
        'Agent pays API. API returns data. Agent answers human.',
        '',
        `Open /buyer ${agent.slug}, create the Circle Agent Wallet on the dashboard, then retry /lp x402 ${agent.slug}.`,
      ]),
      buttonRows: [[{ text: 'Open Agent Dashboard', url: buildAgentProfileUrl(agent, config) }]],
    }
  }
  if (!config.agentWalletServiceSecret) {
    return {
      text: withFooter([
        'x402 buyer mode needs the secure Agent Wallet executor secret.',
        '',
        'Set AGENT_WALLET_SERVICE_SECRET on both the web service and Photon bot.',
        '',
        'What this will do:',
        `Agent wallet ${shortAddress(agent.agentWalletAddress)} pays ${config.x402PolymarketScoutMaxAmount} USDC max for:`,
        compactUrl(config.x402PolymarketScoutUrl),
      ]),
    }
  }

  const executorUrl = `${config.hashPayLinkBaseUrl.replace(/\/+$/, '')}/api/agent-wallet`
  const response = await fetch(executorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-wallet-secret': config.agentWalletServiceSecret,
    },
    body: JSON.stringify({
      action: 'pay-service',
      agentSlug: agent.slug,
      sellerAgentSlug: config.defaultAgentSlug,
      serviceUrl: config.x402PolymarketScoutUrl,
      maxAmount: config.x402PolymarketScoutMaxAmount,
    }),
    signal: AbortSignal.timeout(75_000),
  })
  const data = await response.json().catch(() => undefined) as {
    ok?: boolean
    code?: string
    error?: string
    response?: {
      scout?: { summary?: string; signals?: string[]; opportunities?: Array<Record<string, unknown>>; nextAction?: string; disclaimer?: string }
      receipt?: { provider?: string; price?: string; seller?: string }
      payment?: { payer?: string; amount?: string; network?: string }
    }
    raw?: string
  } | undefined
  if (!response.ok || !data?.ok) {
    if (data?.code === 'circle_session_expired') {
      return {
        text: withFooter([
          'x402 agent payment needs wallet reconnect.',
          '',
          'Your agent wallet address is saved, but Circle requires a fresh Base spending session before it can pay an x402 API.',
          '',
          'Open the agent dashboard, keep the network on Base, login with the same Circle email, then retry /lp x402.',
        ]),
        buttonRows: [[{ text: 'Reconnect Agent Wallet', url: buildAgentProfileUrl(agent, config) }]],
      }
    }
    return {
      text: withFooter([
        'x402 agent payment did not complete.',
        '',
        'What should happen:',
        'Agent pays API. API returns data. Agent answers human.',
        '',
        data?.error ?? 'Agent Wallet executor did not return a successful payment.',
        data?.raw ? data.raw.slice(0, 1200) : '',
      ]),
    }
  }
  const parsed = data.response
  const opportunities = Array.isArray(parsed?.scout?.opportunities) ? parsed.scout.opportunities.slice(0, 3) : []
  const opportunityLines = opportunities.flatMap((opportunity: Record<string, unknown>, index: number) => {
    const title = typeof opportunity.title === 'string' ? opportunity.title : 'Polymarket reward market'
    const dailyReward = typeof opportunity.dailyReward === 'number' ? `${formatUsdc(opportunity.dailyReward)} USDC/day` : 'reward n/a'
    const minSize = typeof opportunity.minSize === 'number' ? `${formatUsdc(opportunity.minSize)} USDC` : 'not provided'
    const liveSpread = typeof opportunity.liveSpread === 'number' ? formatCents(opportunity.liveSpread) : 'n/a'
    const maxSpread = typeof opportunity.maxSpread === 'number' ? formatCents(opportunity.maxSpread) : 'n/a'
    const yesBid = typeof opportunity.suggestedYesBid === 'number' ? formatCents(opportunity.suggestedYesBid) : 'n/a'
    const noBid = typeof opportunity.suggestedNoBid === 'number' ? formatCents(opportunity.suggestedNoBid) : 'n/a'
    const risk = typeof opportunity.lpExecutionRisk === 'string' ? opportunity.lpExecutionRisk : 'unknown'
    const marketUrl = compactPolymarketUrl(opportunity.marketUrl)
    return [
      `${index + 1}. ${title.slice(0, 90)}`,
      `Reward: ${dailyReward} | Min quote: ${minSize}`,
      `Spread: ${liveSpread} / max ${maxSpread}`,
      `Quote: YES ${yesBid} / NO ${noBid} | Risk: ${risk}`,
      marketUrl ? `Link: ${marketUrl}` : undefined,
      '',
    ].filter((line): line is string => typeof line === 'string')
  }).slice(0, -1)
  const topOpportunity = opportunities[0] as Record<string, unknown> | undefined
  const topTitle = typeof topOpportunity?.title === 'string' ? topOpportunity.title.slice(0, 82) : 'top ranked market'
  const topMinSize = typeof topOpportunity?.minSize === 'number' ? topOpportunity.minSize : undefined
  const topYesBid = typeof topOpportunity?.suggestedYesBid === 'number' ? formatCents(topOpportunity.suggestedYesBid) : 'n/a'
  const topNoBid = typeof topOpportunity?.suggestedNoBid === 'number' ? formatCents(topOpportunity.suggestedNoBid) : 'n/a'
  const autopilotLines = topOpportunity
    ? [
        'Autopilot preview (dry-run)',
        topTitle,
        typeof topMinSize === 'number' && topMinSize > POLYMARKET_AUTOPILOT_TEST_CAP_USDC
          ? `Action: skip - min quote ${formatUsdc(topMinSize)} USDC exceeds ${POLYMARKET_AUTOPILOT_TEST_CAP_USDC} USDC test cap.`
          : `Action: would place maker quote up to ${typeof topMinSize === 'number' ? formatUsdc(topMinSize) : POLYMARKET_AUTOPILOT_TEST_CAP_USDC} USDC.`,
        `Entry: YES ${topYesBid} / NO ${topNoBid}`,
        `Risk rule: alert/close review at -${POLYMARKET_AUTOPILOT_STOP_LOSS_PERCENT}% PnL.`,
        'Mode: execution locked until Polymarket trading credentials are added.',
      ]
    : []

  return {
    text: withFooter([
      'x402 LP Scout paid by agent wallet',
      '',
      `Agent: ${agent.slug}`,
      `Wallet: ${shortAddress(agent.agentWalletAddress)}`,
      parsed?.payment?.amount ? `Paid: ${parsed.payment.amount}` : `Max spend: ${config.x402PolymarketScoutMaxAmount} USDC`,
      parsed?.payment?.network ? `Network: ${parsed.payment.network}` : 'Network: Circle Gateway x402',
      '',
      'Agent paid Hash PayLink API and received live Polymarket scout data.',
      '',
      ...(opportunityLines.length ? opportunityLines : (parsed?.scout?.signals ?? []).slice(0, 4).map(signal => `- ${signal}`)),
      opportunityLines.length ? '' : '',
      ...autopilotLines,
      autopilotLines.length ? '' : '',
      'Next: re-check depth, then quote only inside reward spread.',
      parsed?.receipt?.provider ? `Receipt: ${parsed.receipt.provider}` : 'Receipt: Circle Gateway x402',
    ].filter((line): line is string => typeof line === 'string')),
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
        'Funding wallet is separate:',
        '/setpolyfund 0xFundingWallet',
        '/fund polymarket on base',
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
    const agent = request.agentSlug ? getAgent(context.store, config, request.agentSlug) : undefined
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
        `Polymarket public wallet saved: ${shortAddress(trimmed)}`,
        'Use: public watchlist, position lookup, and email alerts.',
        '',
        'For funding links, set a funding wallet separately:',
        '/setpolyfund 0xFundingWallet',
      ]),
    }
  }

  if (/Paste the wallet that should receive Polymarket funding/i.test(replyToText)) {
    if (!isEvmAddress(trimmed)) return promptForPolymarketFundingAddress()
    await context.store.updateUser(context.userId, {
      polymarketFundingAddress: trimmed,
    })
    return {
      text: withFooter([
        `Polymarket funding wallet saved: ${shortAddress(trimmed)}`,
        'Use: Hash PayLink funding checkout recipient.',
        '',
        'To create a funding link:',
        '/fund polymarket on base',
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

  if (cmd === '/pay' || cmd === '/payments') {
    return { text: withFooter(PAYMENTS_HELP_LINES) }
  }

  if ((cmd === '/stream' && trimmed.split(/\s+/).length === 1) || cmd === '/streampay') {
    return { text: withFooter(STREAMPAY_HELP_LINES) }
  }

  if (cmd === '/polymarket') {
    return { text: withFooter(POLYMARKET_HELP_LINES) }
  }

  if (cmd === '/lphelp') {
    return { text: withFooter(LP_HELP_LINES) }
  }

  if (cmd === '/agenthelp') {
    return { text: withFooter(AGENT_HELP_LINES) }
  }

  if (cmd === '/selleragent') {
    return { text: withFooter(SELLER_AGENT_HELP_LINES) }
  }

  if (cmd === '/buyeragent') {
    return { text: withFooter(BUYER_AGENT_HELP_LINES) }
  }

  if (cmd === '/settings') {
    return { text: withFooter(SETTINGS_HELP_LINES) }
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
        `Polymarket public wallet saved: ${shortAddress(address)}`,
        'Use: public watchlist, position lookup, and email alerts.',
        '',
        'Funding is separate:',
        '/setpolyfund 0xFundingWallet',
      ]),
    }
  }

  if (cmd === '/setpolyfund') {
    const address = trimmed.split(/\s+/)[1]
    if (!address) return promptForPolymarketFundingAddress()
    if (!isEvmAddress(address)) return promptForPolymarketFundingAddress()
    await context.store.updateUser(context.userId, {
      polymarketFundingAddress: address,
    })
    return {
      text: withFooter([
        `Polymarket funding wallet saved: ${shortAddress(address)}`,
        'Use: Hash PayLink funding checkout recipient.',
        '',
        'To create a funding link:',
        '/fund polymarket on base',
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

  if (cmd === '/agentwallet') {
    return handleAgentWalletCommand(trimmed, config, context)
  }

  if (cmd === '/createagentwallet') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1] ?? config.defaultAgentSlug)
    if (!slug) return { text: `Use /createagentwallet ${config.defaultAgentSlug}.` }
    return createAgentWalletResult(slug, config)
  }

  if (cmd === '/createbuyerwallet') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1])
    if (!slug) return { text: 'Use /createbuyerwallet buyer-agent.' }
    const existing = getAgent(context.store, config, slug)
    if (existing && !canManageAgent(existing, config, context.userId)) {
      return { text: `Agent name "${slug}" is already registered.` }
    }
    const agent = { ...(existing ?? buyerAgent(slug, context.userId, config)), role: 'buyer' as const }
    await context.store.upsertAgent(agent)
    return {
      text: withFooter([
        'Buyer agent ready',
        '',
        `Agent: ${agent.slug}`,
        '',
        'Open the dashboard and connect the Circle wallet that will spend.',
        '',
        'Use after funding:',
        `/lp x402 ${agent.slug}`,
      ]),
      buttons: [{ text: 'Open Buyer Dashboard', url: buildAgentProfileUrl(agent, config) }],
    }
  }

  if (cmd === '/buyer') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1])
    if (!slug) return { text: 'Use /buyer buyer-agent.' }
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Buyer agent "${slug}" is not registered. Use /createbuyerwallet ${slug}.` }
    if (!canManageAgent(agent, config, context.userId)) return { text: `Only the owner of "${slug}" can open this buyer wallet.` }
    return {
      text: withFooter([
        'Buyer agent',
        '',
        `Agent: ${agent.slug}`,
        `Wallet: ${agent.agentWalletAddress ? shortAddress(agent.agentWalletAddress) : 'not connected'}`,
        '',
        'This wallet spends for x402/API purchases.',
      ]),
      buttons: [{ text: 'Open Buyer Dashboard', url: buildAgentProfileUrl(agent, config) }],
    }
  }

  if (cmd === '/circlewallet') {
    return handleCircleWalletCommand(trimmed, config, context)
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
        `Polymarket watch: ${shortAddress(profile.polymarketAddress)}`,
        `Polymarket fund: ${shortAddress(profile.polymarketFundingAddress)}`,
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
    if (trimmed.split(/\s+/)[1]?.toLowerCase() === 'x402') {
      const buyerSlug = trimmed.split(/\s+/)[2]
      if (!buyerSlug) {
        return {
          text: withFooter([
            'Choose the buyer agent wallet first.',
            '',
            'Use:',
            '/lp x402 buyer-agent',
            '',
            'This is different from tipping Hash PayLink.',
            `For a normal paid question use: /buyagent ${config.defaultAgentSlug} your question`,
          ]),
        }
      }
      return runX402LpScout(config, context, buyerSlug)
    }
    return createPaidLpRequest(trimmed, profile, config, context)
  }

  if (cmd === '/agenticstream') {
    const parsed = parseAgenticStreamArgs(trimmed, profile)
    if ('error' in parsed) return { text: parsed.error }

    const found = getAgent(context.store, config, config.defaultAgentSlug)
    if (!found) return { text: `Agent "${config.defaultAgentSlug}" is not registered.` }
    const agent = await hydrateAgentWallet(found, config)
    if (agent.status !== 'active') return { text: `Agent "${agent.slug}" is not active.` }
    if (!agent.agentWalletAddress) {
      return missingAgentWalletResult(agent, config)
    }

    const stream = buildStreamRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.totalAmount,
      recipient: agent.agentWalletAddress,
      duration: parsed.duration,
      reason: 'Polymarket LP research',
      mode: 'agentic-streaming',
      service: 'polymarket-lp',
      reportEmail: parsed.reportEmail,
      agentSlug: agent.slug,
      amountPerDay: parsed.amountPerDay,
    })
    await context.store.updateUser(context.userId, {
      email: parsed.reportEmail,
      recentStreams: [stream, ...(profile.recentStreams ?? [])].slice(0, 5),
    })
    return {
      text: withFooter([
        'Agentic Streaming link created',
        '',
        'Service: Polymarket LP Research',
        `Agent: ${agent.slug}`,
        `Rate: ${parsed.amountPerDay} USDC/day`,
        `Duration: ${stream.duration}`,
        `Total stream: ${stream.amount} USDC`,
        `Report email: ${parsed.reportEmail}`,
        `Recipient: ${shortAddress(stream.recipient)}`,
        '',
        'Open StreamPay to fund and deploy the Arc USDC stream.',
        'After deployment, Hash PayLink records this as the LP research subscription.',
      ]),
      buttons: [{ text: 'Open Agentic Streaming', url: stream.streamUrl }],
    }
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

  if (cmd === '/registeragent' || cmd === '/verifyagent') {
    const parsed = parseAgentRegistrationArgs(trimmed)
    if ('error' in parsed) return { text: parsed.error }
    const existing = getAgent(context.store, config, parsed.slug)
    if (existing && !canManageAgent(existing, config, context.userId)) {
      return { text: `Agent name "${parsed.slug}" is already registered.` }
    }

    const verified = await verifyAgentEndpoint(parsed, context.userId)
    if ('error' in verified) return { text: verified.error }
    await context.store.upsertAgent({ ...verified, role: 'seller' })
    return {
      text: withFooter([
        'Agent registered',
        '',
        `Seller: ${verified.slug}`,
        `Ask price: ${verified.priceUsdc} USDC`,
        `Endpoint: ${verified.endpointUrl}`,
        '',
        'Next:',
        `/createagentwallet ${verified.slug}`,
        `/agent ${verified.slug}`,
      ]),
    }
  }

  if (cmd === '/agentwalletsetup') {
    const slug = normalizeAgentSlug(trimmed.split(/\s+/)[1])
    if (!slug) return { text: `Use /agent ${config.defaultAgentSlug}.` }
    const agent = getAgent(context.store, config, slug)
    if (!agent) return createAgentWalletResult(slug, config)
    if (!canManageAgent(agent, config, context.userId)) return { text: `Only the owner of "${slug}" can provision its Agent Wallet.` }
    return agentWalletSetupResult(agent, config)
  }

  if (cmd === '/setagentwallet') {
    const [, slugRaw, address] = trimmed.split(/\s+/, 3)
    const slug = normalizeAgentSlug(slugRaw)
    if (!slug || !address || !isEvmAddress(address)) {
      return { text: 'Use /setagentwallet agent-name 0xCircleAgentWallet.' }
    }
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (!canManageAgent(agent, config, context.userId)) return { text: `Only the owner of "${slug}" can update its Agent Wallet.` }
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
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (!canManageAgent(agent, config, context.userId)) return { text: `Only the owner of "${slug}" can update its default price.` }
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
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    if (!canManageAgent(agent, config, context.userId)) return { text: `Only the owner of "${slug}" can update its streaming retainer.` }
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

  if (cmd === '/agent') {
    const rawSlug = trimmed.split(/\s+/)[1]
    const slug = !rawSlug || ['agent', 'helper', 'hashpaylink', 'hash-paylink'].includes(rawSlug.toLowerCase())
      ? config.defaultAgentSlug
      : normalizeAgentSlug(rawSlug)
    if (!slug) return { text: `Use /agent ${config.defaultAgentSlug}.` }
    if (slug === config.defaultAgentSlug) {
      return {
        text: withFooter([
          'Hash PayLink Agent',
          '',
          'Open the helper inside your Telegram dashboard.',
        ]),
        buttons: [{ text: 'Open Hash PayLink Agent', url: buildTelegramAgentLauncherUrl(config, context.userId) }],
      }
    }
    const agent = getAgent(context.store, config, slug)
    if (!agent) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    const hydrated = await hydrateAgentWallet(agent, config)
    if (hydrated.status !== 'active') return { text: `Agent "${slug}" is not active.` }
    return agentDashboard(hydrated, config)
  }

  if (cmd === '/agents') {
    const agents = await Promise.all(listAgents(context.store, config).filter(agent => agent.status === 'active' && agent.role !== 'buyer').slice(0, 10).map(agent => hydrateAgentWallet(agent, config)))
    if (!agents.length) return { text: 'No seller agents yet.' }
    return {
      text: withFooter([
        'Seller agents',
        '',
        ...agents.flatMap(agent => [
          `${agent.slug}`,
          `Wallet: ${agent.agentWalletAddress ? shortAddress(agent.agentWalletAddress) : 'not connected'}`,
          `Ask: ${agent.priceUsdc} USDC`,
          agent.streamPriceUsdc && agent.streamDuration
            ? `Stream: ${agent.streamPriceUsdc} USDC for ${agent.streamDuration}`
            : 'Stream: dashboard setup',
          `/agent ${agent.slug}`,
          '',
        ]).filter(Boolean).slice(0, -1),
      ]),
    }
  }

  if (cmd === '/fundagent') {
    const parts = trimmed.split(/\s+/)
    const slug = normalizeAgentSlug(parts[1])
    const amount = parseUsdcAmount(parts[2])
    if (!slug || !amount) return { text: 'Use /fundagent agent-name 10 USDC on base.' }
    const found = getAgent(context.store, config, slug)
    if (!found) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    const agent = await hydrateAgentWallet(found, config)
    if (agent.status !== 'active') return { text: `Agent "${slug}" is not active.` }
    if (!agent.agentWalletAddress) {
      return missingAgentWalletResult(agent, config)
    }

    const partsForNetwork = [...parts]
    const network = extractNetworkOverride(partsForNetwork, userNetwork(profile, config))
    if (network === 'solana') {
      return { text: 'Agent Wallet funding currently supports EVM Circle Agent Wallets on Base or Arbitrum. Use /fundagent agent-name 10 USDC on base.' }
    }
    const request = buildAgentFundingRequest(agent, amount, network, config)
    if (!request) return { text: 'Could not create the agent funding link. Check that the agent wallet is set.' }
    requests.set(request.id, request)
    latestRequestByUser.set(context.userId, request.id)
    await context.store.updateUser(context.userId, {
      latestRequest: request,
      recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
    })

    return {
      text: withFooter([
        'Agent wallet funding link created',
        '',
        `Agent: ${agent.slug}`,
        `Amount: ${request.amount} USDC`,
        `Network: ${request.network}`,
        `Wallet: ${shortAddress(agent.agentWalletAddress)}`,
        '',
        'This funds the agent treasury wallet directly through Hash PayLink.',
      ]),
      buttons: [{ text: 'Fund Agent Wallet', url: request.payUrl }],
    }
  }

  if (cmd === '/fund') {
    const parts = trimmed.split(/\s+/)
    if ((parts[1] ?? '').toLowerCase() !== 'polymarket') {
      return { text: 'Use /fund polymarket on base or /fund polymarket 2 on base.' }
    }

    const partsForNetwork = [...parts]
    const network = extractNetworkOverride(partsForNetwork, userNetwork(profile, config))
    if (network === 'solana') {
      return { text: 'Polymarket funding currently supports saved EVM Polymarket wallets on Base or Arbitrum. Use /fund polymarket on base.' }
    }

    const amount = parseUsdcAmount(partsForNetwork[2])
    if (partsForNetwork[2] && !amount) return { text: 'Use /fund polymarket on base or /fund polymarket 2 on base.' }
    if (isBelowPolymarketFundingMinimum(amount)) {
      return { text: `Polymarket funding minimum is ${POLYMARKET_MIN_FUNDING_USDC} USDC. Use /fund polymarket ${POLYMARKET_MIN_FUNDING_USDC} on base or /fund polymarket on base.` }
    }
    if (!profile.polymarketFundingAddress) return { text: 'No Polymarket funding wallet is saved yet. Use /setpolyfund 0xFundingWallet first.' }

    const request = buildPolymarketFundingRequest(profile, amount, network, config)
    if (!request) return { text: 'Could not create the Polymarket funding link. Check your saved Polymarket funding wallet.' }
    requests.set(request.id, request)
    latestRequestByUser.set(context.userId, request.id)
    await context.store.updateUser(context.userId, {
      latestRequest: request,
      recentRequests: [request, ...(profile.recentRequests ?? [])].slice(0, 5),
    })

    return {
      text: withFooter([
        'Polymarket funding link created',
        '',
        `Amount: ${amount ? `${amount} USDC` : `payer enters amount, minimum ${POLYMARKET_MIN_FUNDING_USDC} USDC`}`,
        `Network: ${request.network}`,
        `Funding wallet: ${shortAddress(profile.polymarketFundingAddress)}`,
        profile.polymarketAddress ? `Watch wallet: ${shortAddress(profile.polymarketAddress)}` : '',
        '',
        'Memo: Polymarket',
      ].filter(Boolean)),
      buttons: [{ text: 'Fund Polymarket', url: request.payUrl }],
    }
  }

  if (cmd === '/askagent' || cmd === '/buyagent') {
    const parts = trimmed.split(/\s+/)
    const slug = normalizeAgentSlug(parts[1])
    if (!slug) return { text: 'Use /buyagent seller-agent your question.' }
    const found = getAgent(context.store, config, slug)
    if (!found) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    const agent = await hydrateAgentWallet(found, config)
    if (agent.role === 'buyer') return { text: `Agent "${slug}" is a buyer agent. Use a seller agent like ${config.defaultAgentSlug}.` }
    if (agent.status !== 'active') return { text: `Agent "${slug}" is not active.` }
    const question = parts.slice(2).join(' ').trim()
    if (!question) return { text: `Ask a question after the agent name. Example: /buyagent ${slug} Analyze BTC risk.` }
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
    const found = getAgent(context.store, config, slug)
    if (!found) return { text: `Agent "${slug}" is not registered on Hash PayLink.` }
    const agent = await hydrateAgentWallet(found, config)
    if (agent.status !== 'active') return { text: `Agent "${slug}" is not active.` }

    const parsed = parseAgentStreamArgs(trimmed, agent)
    if ('error' in parsed) return { text: parsed.error }
    const ownerProfile = context.store.getUser(agent.ownerUserId)
    const recipient = agent.agentWalletAddress ?? ownerProfile.evmAddress
    if (!recipient) {
      return missingAgentWalletResult(agent, config)
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
        recipientEmail: parsed.recipient,
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
      recipientEmail: pending.recipientEmail,
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
