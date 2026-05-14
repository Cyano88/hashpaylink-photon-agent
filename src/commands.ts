import type { AppConfig, Network } from './config.js'
import {
  buildPaymentRequest,
  buildStreamRequest,
  type AgentRegistration,
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
  '/request 10 USDC for design net=solana',
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
  'AI Paid Access',
  '/askpaid 1 USDC your question',
  '/verifyagent name https://agent.example/ask price=2',
  '/askagent name your question',
  '/agents',
  '',
  'Arc Streaming',
  '/stream 100 USDC to 0xRecipient for 7d reason="research retainer"',
  '/streams',
  '',
  'Settings',
  '/setevm 0xYourAddress',
  '/setsol YourSolanaAddress',
  '/network solana',
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
  | { amount: string; recipient: string; duration: string; reason: string }
  | { error: string }

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

function parsePaidQuestionArgs(text: string, fallbackNetwork: Network): ParsedPaidQuestionArgs {
  const parts = text.trim().split(/\s+/)
  const amount = parseUsdcAmount(parts[1])
  if (!amount) {
    return { error: 'Use /askpaid 1 USDC your question. Amounts must use up to 6 decimals.' }
  }

  let network = fallbackNetwork
  const networkFlagIndex = parts.findIndex(part => part.startsWith('network=') || part.startsWith('net='))
  if (networkFlagIndex >= 0) {
    network = parseNetwork(parts[networkFlagIndex].split('=')[1], fallbackNetwork)
    parts.splice(networkFlagIndex, 1)
  }

  const questionStart = parts[2]?.toLowerCase() === 'usdc' ? 3 : 2
  const question = parts.slice(questionStart).join(' ').trim()
  if (!question) return { error: 'Add the question after the price. Example: /askpaid 1 USDC What should I build?' }
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
  if (!isEvmAddress(recipient)) return { error: 'Stream recipient must be an EVM 0x address.' }

  const duration = parts[forIndex + 1].toLowerCase()
  if (!/^\d+[dhw]$/.test(duration)) return { error: 'Duration must look like 7d, 24h, or 2w.' }

  const reasonMatch = text.match(/\breason=(?:"([^"]+)"|(.+))$/i)
  const reason = (reasonMatch?.[1] ?? reasonMatch?.[2] ?? 'Arc USDC stream').trim().slice(0, MAX_MEMO_LENGTH)
  return { amount, recipient, duration, reason }
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

function getRecipientForNetwork(profile: UserProfile, config: AppConfig, network: Network) {
  return network === 'solana'
    ? profile.solanaAddress ?? config.defaultSolanaAddress
    : profile.evmAddress ?? config.defaultEvmAddress
}

function paidAccessPayerHint(request: PaymentRequest) {
  return [
    'After paying, use the payer name you entered on the payment page:',
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

  if (cmd === '/askpaid') {
    const parsed = parsePaidQuestionArgs(trimmed, userNetwork(profile, config))
    if ('error' in parsed) return { text: parsed.error }

    const recipient = getRecipientForNetwork(profile, config, parsed.network)
    if (!recipient) return parsed.network === 'solana' ? promptForSolanaRecipient() : promptForEvmRecipient()

    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: parsed.amount,
      memo: 'Hash PayLink Circle/Arc AI access',
      network: parsed.network,
      evmAddress: parsed.network === 'solana' ? profile.evmAddress ?? config.defaultEvmAddress : recipient,
      solanaAddress: parsed.network === 'solana' ? recipient : profile.solanaAddress ?? config.defaultSolanaAddress,
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
        'Agent: Hash PayLink Circle/Arc Strategy AI',
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
    const [, requestedId, payer] = trimmed.split(/\s+/, 3)
    if (!requestedId || !payer) return { text: 'Use /answer <request-id> <payer-name>.' }
    const request = findRequest(requestedId, profile)
    if (!request) return { text: 'Paid access request not found. Use /requests to see recent requests.' }
    if (request.kind === 'agent_access') {
      const agent = request.agentSlug ? context.store.getAgent(request.agentSlug) : undefined
      if (!agent || agent.status !== 'active') return { text: 'Agent is no longer active on Hash PayLink.' }
      const result = await callExternalAgent(agent, request, payer, config)
      if ('error' in result) return { text: result.error ?? 'Agent access failed.' }
      return {
        text: withFooter([
          `Payment verified on 0G.`,
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
        'Agent: Hash PayLink Circle/Arc Strategy AI',
        '',
        'Answer:',
        result.answer ?? '',
        '',
        result.proof?.ogExplorer ? `Proof: ${result.proof.ogExplorer}` : 'Proof: 0G verification returned',
      ]),
    }
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
        `Price: ${verified.priceUsdc} USDC`,
        `Endpoint: ${verified.endpointUrl}`,
        '',
        `Users can now call:`,
        `/askagent ${verified.slug} your question`,
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
          `${agent.slug} - ${agent.priceUsdc} USDC`,
          `/askagent ${agent.slug} your question`,
          '',
        ]).slice(0, -1),
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
    const recipient = getRecipientForNetwork(profile, config, network)
    if (!recipient) return network === 'solana' ? promptForSolanaRecipient() : promptForEvmRecipient()
    const request = buildPaymentRequest({
      baseUrl: config.hashPayLinkBaseUrl,
      amount: agent.priceUsdc,
      memo: `Agent access: ${agent.slug}`,
      network,
      evmAddress: network === 'solana' ? profile.evmAddress ?? config.defaultEvmAddress : recipient,
      solanaAddress: network === 'solana' ? recipient : profile.solanaAddress ?? config.defaultSolanaAddress,
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

  if (cmd === '/stream') {
    const parsed = parseStreamArgs(trimmed)
    if ('error' in parsed) return { text: parsed.error }
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

  if (cmd === '/streams') {
    const streams = profile.recentStreams ?? []
    if (!streams.length) return { text: 'No recent streams found. Create one with /stream 100 USDC to 0xRecipient for 7d.' }
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
        ]).slice(0, -1),
      ]),
      buttonRows: streams.map((stream, index) => [
        { text: `Open ${index + 1}`, url: stream.streamUrl },
      ]),
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
