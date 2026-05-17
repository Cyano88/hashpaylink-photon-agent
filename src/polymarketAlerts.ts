import type { AppConfig } from './config.js'
import { emailDeliveryReady, sendEmail } from './email.js'
import type { ProfileStore, UserProfile } from './store.js'

const DEFAULT_THRESHOLD_PERCENT = 30
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 12_000

type PolymarketPosition = {
  title?: string
  outcome?: string
  size?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  curPrice?: number
  asset?: string
  tokenId?: string
  conditionId?: string
  marketId?: string
  slug?: string
}

export type PolymarketAlertCandidate = {
  key: string
  title: string
  outcome: string
  currentValue?: number
  cashPnl?: number
  percentPnl: number
  curPrice?: number
  marketUrl?: string
}

export type PolymarketAlertCheck = {
  ok: boolean
  alerts: PolymarketAlertCandidate[]
  error?: string
}

function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

function formatUsdc(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unavailable'
  return `${value.toLocaleString('en-US', { minimumFractionDigits: value > 0 && value < 1 ? 2 : 0, maximumFractionDigits: 6 })} USDC`
}

function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`
}

function positionKey(position: PolymarketPosition) {
  return [
    position.asset,
    position.tokenId,
    position.conditionId,
    position.marketId,
    position.slug,
    position.title,
    position.outcome,
  ].find(value => typeof value === 'string' && value.trim()) ?? `${position.title ?? 'market'}:${position.outcome ?? 'outcome'}`
}

function marketUrl(position: PolymarketPosition) {
  return position.slug ? `https://polymarket.com/market/${position.slug}` : 'https://polymarket.com/portfolio'
}

async function fetchPositions(address: string) {
  const response = await fetchWithTimeout(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(address)}&limit=100&sortBy=CURRENT&sortDirection=DESC&sizeThreshold=0`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'HashPayLinkPhotonAgent/0.1',
    },
  })
  if (!response.ok) throw new Error('Could not fetch Polymarket positions.')
  return await response.json() as PolymarketPosition[]
}

function threshold(profile: UserProfile) {
  const value = profile.polymarketAlertThresholdPercent
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD_PERCENT
}

export async function checkPolymarketRisk(profile: UserProfile): Promise<PolymarketAlertCheck> {
  if (!profile.polymarketAddress) return { ok: false, alerts: [], error: 'No Polymarket wallet is saved. Use /setpoly 0xYourPolymarketWallet.' }
  try {
    const cutoff = -Math.abs(threshold(profile))
    const positions = await fetchPositions(profile.polymarketAddress)
    const alerts = positions
      .filter(position => typeof position.percentPnl === 'number' && position.percentPnl <= cutoff)
      .filter(position => (position.currentValue ?? 0) > 0 || (position.size ?? 0) > 0)
      .map(position => ({
        key: positionKey(position),
        title: position.title ?? 'Untitled Polymarket market',
        outcome: position.outcome ?? 'Outcome',
        currentValue: position.currentValue,
        cashPnl: position.cashPnl,
        percentPnl: position.percentPnl as number,
        curPrice: position.curPrice,
        marketUrl: marketUrl(position),
      }))
    return { ok: true, alerts }
  } catch (err) {
    return { ok: false, alerts: [], error: err instanceof Error ? err.message : 'Could not check Polymarket positions.' }
  }
}

export function formatPolymarketAlertStatus(profile: UserProfile, config: AppConfig) {
  const ready = emailDeliveryReady(config)
  return [
    'Polymarket email alerts',
    '',
    `Email: ${profile.email ?? 'not set'}`,
    `Wallet: ${profile.polymarketAddress ? shortAddress(profile.polymarketAddress) : 'not set'}`,
    `Status: ${profile.polymarketEmailAlertsEnabled ? 'on' : 'off'}`,
    `Trigger: open position PnL at or below -${threshold(profile)}%`,
    `Email delivery: ${ready ? 'configured' : 'not configured'}`,
    '',
    'Commands:',
    '/setemail you@example.com',
    '/polyalerts on',
    '/polyalerts check',
    '/polyalerts off',
  ].join('\n')
}

function alertEmailText(address: string, alerts: PolymarketAlertCandidate[]) {
  return [
    'Hash PayLink Polymarket risk alert',
    '',
    `Wallet: ${shortAddress(address)}`,
    `Positions at or below the risk threshold: ${alerts.length}`,
    '',
    ...alerts.flatMap((alert, index) => [
      `${index + 1}. ${alert.title.slice(0, 120)}`,
      `${alert.outcome} - PnL ${alert.percentPnl.toFixed(2)}%`,
      `Current value: ${formatUsdc(alert.currentValue)}`,
      `Cash PnL: ${formatUsdc(alert.cashPnl)}`,
      typeof alert.curPrice === 'number' ? `Current price: ${Math.round(alert.curPrice * 100)}c` : undefined,
      `Review: ${alert.marketUrl ?? 'https://polymarket.com/portfolio'}`,
      '',
    ].filter(Boolean) as string[]),
    'This is a monitoring alert from public Polymarket portfolio data, not financial advice. Visit Polymarket directly before deciding whether to close or adjust a position.',
  ].join('\n')
}

export async function sendDuePolymarketAlerts(userId: string, profile: UserProfile, store: ProfileStore, config: AppConfig) {
  if (!profile.polymarketEmailAlertsEnabled || !profile.email || !profile.polymarketAddress) return { sent: 0, checked: false }

  const checked = await checkPolymarketRisk(profile)
  await store.updateUser(userId, { polymarketAlertLastCheckedAt: Date.now() })
  if (!checked.ok || !checked.alerts.length) return { sent: 0, checked: true }

  const now = Date.now()
  const lastSent = profile.polymarketAlertLastSentByPosition ?? {}
  const due = checked.alerts.filter(alert => now - (lastSent[alert.key] ?? 0) >= ALERT_COOLDOWN_MS)
  if (!due.length) return { sent: 0, checked: true }

  await sendEmail(config, {
    to: profile.email,
    subject: `Polymarket alert: ${due.length} position${due.length === 1 ? '' : 's'} down ${threshold(profile)}%+`,
    text: alertEmailText(profile.polymarketAddress, due),
  })

  const nextLastSent = { ...lastSent }
  for (const alert of due) nextLastSent[alert.key] = now
  await store.updateUser(userId, {
    polymarketAlertLastSentByPosition: nextLastSent,
    polymarketAlertLastCheckedAt: now,
  })
  return { sent: due.length, checked: true }
}

export function startPolymarketAlertWorker(config: AppConfig, store: ProfileStore) {
  if (!config.emailEnabled) {
    console.log('Polymarket email alerts disabled.')
    return
  }
  if (!emailDeliveryReady(config)) {
    console.warn('Polymarket email alerts disabled: missing SENDGRID_API_KEY or ALERT_FROM_EMAIL.')
    return
  }

  const intervalMs = Math.max(5, config.polymarketAlertIntervalMinutes) * 60 * 1_000
  let running = false

  async function run() {
    if (running) return
    running = true
    try {
      for (const [userId, profile] of store.listUsers()) {
        try {
          await sendDuePolymarketAlerts(userId, profile, store, config)
        } catch (err) {
          console.error('[polymarket-alerts]', userId, err instanceof Error ? err.message : err)
        }
      }
    } finally {
      running = false
    }
  }

  console.log(`Polymarket email alerts enabled; checking every ${Math.round(intervalMs / 60_000)} minutes.`)
  void run()
  setInterval(() => void run(), intervalMs)
}
