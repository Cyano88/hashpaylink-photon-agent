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
  adminUserIds: string[]
  emailEnabled: boolean
  sendgridApiKey: string
  alertFromEmail: string
  alertFromName: string
  alertReplyToEmail: string
  polymarketAlertIntervalMinutes: number
  defaultAgentSlug: string
  defaultAgentEndpointUrl: string
  defaultAgentPriceUsdc: string
  defaultAgentStreamPriceUsdc: string
  defaultAgentStreamDuration: string
  defaultAgentWalletAddress: string
  agentWalletLookupEnabled: boolean
  x402PolymarketScoutUrl: string
  x402PolymarketScoutMaxAmount: string
  agentWalletServiceSecret: string
  circleCliEnabled: boolean
  circleCliSpendingEnabled: boolean
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

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(clean(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
    adminUserIds: optional('ADMIN_USER_IDS')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    emailEnabled: process.env.EMAIL_ENABLED === undefined ? false : enabled(process.env.EMAIL_ENABLED),
    sendgridApiKey: optional('SENDGRID_API_KEY'),
    alertFromEmail: optional('ALERT_FROM_EMAIL'),
    alertFromName: optional('ALERT_FROM_NAME') || 'Hash PayLink Alerts',
    alertReplyToEmail: optional('ALERT_REPLY_TO_EMAIL'),
    polymarketAlertIntervalMinutes: positiveNumber(process.env.POLYMARKET_ALERT_INTERVAL_MINUTES, 60),
    defaultAgentSlug: optional('DEFAULT_AGENT_SLUG') || 'hashpaylink-agent',
    defaultAgentEndpointUrl: optional('DEFAULT_AGENT_ENDPOINT_URL') || 'https://hashpaylink.com/api/agent-ask',
    defaultAgentPriceUsdc: optional('DEFAULT_AGENT_PRICE_USDC') || '1',
    defaultAgentStreamPriceUsdc: optional('DEFAULT_AGENT_STREAM_PRICE_USDC') || '25',
    defaultAgentStreamDuration: optional('DEFAULT_AGENT_STREAM_DURATION') || '7d',
    defaultAgentWalletAddress: optional('DEFAULT_AGENT_WALLET_ADDRESS'),
    agentWalletLookupEnabled: process.env.AGENT_WALLET_LOOKUP_ENABLED === undefined ? true : enabled(process.env.AGENT_WALLET_LOOKUP_ENABLED),
    x402PolymarketScoutUrl: optional('X402_POLYMARKET_SCOUT_URL') || `${(optional('HASH_PAYLINK_BASE_URL') || 'https://hashpaylink.com').replace(/\/+$/, '')}/api/x402/polymarket-scout`,
    x402PolymarketScoutMaxAmount: optional('X402_POLYMARKET_SCOUT_MAX_AMOUNT') || '0.01',
    agentWalletServiceSecret: optional('AGENT_WALLET_SERVICE_SECRET'),
    circleCliEnabled: enabled(process.env.CIRCLE_CLI_ENABLED),
    circleCliSpendingEnabled: enabled(process.env.CIRCLE_CLI_SPENDING_ENABLED),
  }
}
