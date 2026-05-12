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
}

export function createRequestId() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24)
}

export function buildPaymentRequest(input: BuildInput): PaymentRequest {
  const id = createRequestId()
  const base = input.baseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()

  params.set('id', id)
  params.set('amt', input.amount)
  params.set('memo', input.memo)
  params.set('net', input.network)
  params.set('mode', 'wallet')
  params.set('multi', '1')
  params.set('event', '1')
  params.set('source', 'telegram')

  if (input.evmAddress) params.set('evm', input.evmAddress)
  if (input.solanaAddress) params.set('sol', input.solanaAddress)

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
