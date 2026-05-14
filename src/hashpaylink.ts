import type { Network } from './config.js'

export type PaymentRequest = {
  amount: string
  memo: string
  network: Network
  kind: 'collection'
  payUrl: string
  dashboardUrl: string
  id: string
}

type BuildInput = {
  baseUrl: string
  amount: string
  memo: string
  network: Network
  evmAddress: string
  solanaAddress: string
  returnUrl?: string
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

  if (input.evmAddress) params.set('e', input.evmAddress)
  if (input.solanaAddress) params.set('s', input.solanaAddress)

  return {
    amount: input.amount,
    memo: input.memo,
    network: input.network,
    kind: 'collection',
    id,
    payUrl: `${base}/pay?${params.toString()}`,
    dashboardUrl: `${base}/dashboard?${params.toString()}`,
  }
}
