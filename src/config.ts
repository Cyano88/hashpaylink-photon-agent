import 'dotenv/config'

export type Network = 'base' | 'arbitrum' | 'solana'

export type AppConfig = {
  hashPayLinkBaseUrl: string
  telegramBotToken: string
  photonProjectId: string
  photonSecretKey: string
  defaultEvmAddress: string
  defaultSolanaAddress: string
  defaultNetwork: Network
}

const NETWORKS = new Set<Network>(['base', 'arbitrum', 'solana'])

function clean(value: string | undefined) {
  return (value ?? '').trim()
}

function required(name: string) {
  const value = clean(process.env[name])
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optional(name: string) {
  return clean(process.env[name])
}

function network(value: string | undefined): Network {
  const candidate = clean(value).toLowerCase() as Network
  return NETWORKS.has(candidate) ? candidate : 'base'
}

export function loadConfig(): AppConfig {
  return {
    hashPayLinkBaseUrl: optional('HASH_PAYLINK_BASE_URL') || 'https://hashpaylink.com',
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    photonProjectId: optional('PHOTON_PROJECT_ID'),
    photonSecretKey: optional('PHOTON_SECRET_KEY'),
    defaultEvmAddress: optional('DEFAULT_EVM_ADDRESS'),
    defaultSolanaAddress: optional('DEFAULT_SOLANA_ADDRESS'),
    defaultNetwork: network(process.env.DEFAULT_NETWORK),
  }
}
