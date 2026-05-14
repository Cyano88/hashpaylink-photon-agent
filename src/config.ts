import 'dotenv/config'

export type Network = 'base' | 'arbitrum' | 'solana'

export type AppConfig = {
  hashPayLinkBaseUrl: string
  telegramEnabled: boolean
  telegramBotToken: string
  photonProjectId: string
  photonSecretKey: string
  whatsappEnabled: boolean
  whatsappAccessToken: string
  whatsappPhoneNumberId: string
  whatsappAppSecret: string
  whatsappVerifyToken: string
  whatsappGraphVersion: string
  whatsappPort: number
  defaultEvmAddress: string
  defaultSolanaAddress: string
  defaultNetwork: Network
  storePath: string
  telegramReturnUrl: string
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

function optionalAny(...names: string[]) {
  for (const name of names) {
    const value = optional(name)
    if (value) return value
  }
  return ''
}

function network(value: string | undefined): Network {
  const candidate = clean(value).toLowerCase() as Network
  return NETWORKS.has(candidate) ? candidate : 'base'
}

function enabled(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase())
}

function port(value: string | undefined) {
  const parsed = Number(clean(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3000
}

export function loadConfig(): AppConfig {
  return {
    hashPayLinkBaseUrl: optional('HASH_PAYLINK_BASE_URL') || 'https://hashpaylink.com',
    telegramEnabled: process.env.TELEGRAM_ENABLED === undefined ? true : enabled(process.env.TELEGRAM_ENABLED),
    telegramBotToken: optional('TELEGRAM_BOT_TOKEN'),
    photonProjectId: optional('PHOTON_PROJECT_ID'),
    photonSecretKey: optional('PHOTON_SECRET_KEY'),
    whatsappEnabled: enabled(process.env.WHATSAPP_ENABLED),
    whatsappAccessToken: optionalAny('WHATSAPP_ACCESS_TOKEN', 'WA_TOKEN'),
    whatsappPhoneNumberId: optionalAny('WHATSAPP_PHONE_NUMBER_ID', 'WA_NUMBER_ID'),
    whatsappAppSecret: optionalAny('WHATSAPP_APP_SECRET', 'WA_SECRET'),
    whatsappVerifyToken: optionalAny('WHATSAPP_VERIFY_TOKEN', 'WA_VERIFY_TOKEN'),
    whatsappGraphVersion: optional('WHATSAPP_GRAPH_VERSION') || 'v20.0',
    whatsappPort: port(process.env.PORT ?? process.env.WHATSAPP_PORT),
    defaultEvmAddress: optional('DEFAULT_EVM_ADDRESS'),
    defaultSolanaAddress: optional('DEFAULT_SOLANA_ADDRESS'),
    defaultNetwork: network(process.env.DEFAULT_NETWORK),
    storePath: optional('STORE_PATH') || './data/profiles.json',
    telegramReturnUrl: optional('TELEGRAM_RETURN_URL'),
  }
}
