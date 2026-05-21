import type { Network } from './config.js'

export type PaymentRequest = {
  amount: string
  memo: string
  network: Network
  kind: 'collection' | 'ai_access' | 'agent_access' | 'lp_access' | 'agent_funding'
  payUrl: string
  dashboardUrl: string
  id: string
  question?: string
  agentSlug?: string
}

type BuildInput = {
  baseUrl: string
  amount: string
  memo: string
  network: Network
  evmAddress: string
  solanaAddress: string
  returnUrl?: string
  kind?: PaymentRequest['kind']
  question?: string
  agentSlug?: string
}

export type AgentRegistration = {
  slug: string
  endpointUrl: string
  priceUsdc: string
  agentWalletAddress?: string
  agentWalletChain?: 'arc-testnet'
  streamPriceUsdc?: string
  streamDuration?: string
  ownerUserId: string
  status: 'active' | 'disabled'
  createdAt: number
  verifiedAt?: number
}

export type StreamRequest = {
  id: string
  amount: string
  recipient: string
  recipientEmail?: string
  duration: string
  reason: string
  streamUrl: string
  createdAt: number
  mode?: string
  service?: string
  reportEmail?: string
  agentSlug?: string
  amountPerDay?: string
}

export type PendingStreamRequest = {
  id: string
  amount: string
  recipientEmail: string
  duration: string
  reason: string
  prepareUrl: string
  createdAt: number
}

export function createRequestId() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24)
}

export function buildPaymentRequest(input: BuildInput): PaymentRequest {
  const id = createRequestId()
  const base = input.baseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()

  params.set('id', id)
  params.set('a', input.amount)
  params.set('m', input.memo)
  params.set('n', input.network)
  params.set('x', '1')
  params.set('v', '1')
  params.set('src', 't')
  if (input.returnUrl) params.set('r', input.returnUrl)
  if (input.kind) params.set('kind', input.kind)
  if (input.agentSlug) {
    params.set('agent', input.agentSlug)
    params.set('agentSlug', input.agentSlug)
  }

  if (input.evmAddress) params.set('e', input.evmAddress)
  if (input.solanaAddress) params.set('s', input.solanaAddress)

  return {
    amount: input.amount,
    memo: input.memo,
    network: input.network,
    kind: input.kind ?? 'collection',
    id,
    question: input.question,
    agentSlug: input.agentSlug,
    payUrl: `${base}/pay?${params.toString()}`,
    dashboardUrl: `${base}/dashboard?${params.toString()}`,
  }
}

export function buildStreamRequest(input: {
  baseUrl: string
  amount: string
  recipient: string
  recipientEmail?: string
  duration: string
  reason: string
  mode?: string
  service?: string
  reportEmail?: string
  agentSlug?: string
  amountPerDay?: string
}): StreamRequest {
  const id = createRequestId()
  const base = input.baseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('app', 'streampay')
  params.set('amount', input.amount)
  params.set('recipient', input.recipient)
  if (input.recipientEmail) params.set('recipientEmail', input.recipientEmail)
  params.set('duration', input.duration)
  params.set('reason', input.reason)
  params.set('src', 'telegram')
  params.set('wallet', 'circle')
  params.set('id', id)
  if (input.mode) params.set('mode', input.mode)
  if (input.service) params.set('service', input.service)
  if (input.reportEmail) params.set('reportEmail', input.reportEmail)
  if (input.agentSlug) params.set('agent', input.agentSlug)
  if (input.amountPerDay) params.set('amountPerDay', input.amountPerDay)

  return {
    id,
    amount: input.amount,
    recipient: input.recipient,
    recipientEmail: input.recipientEmail,
    duration: input.duration,
    reason: input.reason,
    streamUrl: `${base}/?${params.toString()}`,
    createdAt: Date.now(),
    mode: input.mode,
    service: input.service,
    reportEmail: input.reportEmail,
    agentSlug: input.agentSlug,
    amountPerDay: input.amountPerDay,
  }
}

export function buildRecipientPrepareUrl(input: {
  baseUrl: string
  recipientEmail: string
  pendingId?: string
}) {
  const base = input.baseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('app', 'streampay')
  params.set('src', 'telegram')
  params.set('wallet', 'circle')
  params.set('email', input.recipientEmail)
  if (input.pendingId) params.set('pending', input.pendingId)
  return `${base}/recipient?${params.toString()}`
}

export function buildPendingStreamRequest(input: {
  baseUrl: string
  amount: string
  recipientEmail: string
  duration: string
  reason: string
}): PendingStreamRequest {
  const id = createRequestId()
  return {
    id,
    amount: input.amount,
    recipientEmail: input.recipientEmail,
    duration: input.duration,
    reason: input.reason,
    prepareUrl: buildRecipientPrepareUrl({ ...input, pendingId: id }),
    createdAt: Date.now(),
  }
}
