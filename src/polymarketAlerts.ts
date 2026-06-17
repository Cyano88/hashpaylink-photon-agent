import type { AppConfig } from './config.js'
import { emailDeliveryReady, sendEmail } from './email.js'
import type { ProfileStore, UserProfile } from './store.js'

const DEFAULT_THRESHOLD_PERCENT = 30
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 12_000

type PolymarketPosition = {
  [key: string]: unknown
  title?: string
  outcome?: string
  size?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  curPrice?: number
  endDate?: string
  end_date?: string
  resolutionDate?: string
  resolution_date?: string
  closedTime?: string
  closed_time?: string
  closed?: boolean
  resolved?: boolean
  settled?: boolean
  redeemable?: boolean
  mergeable?: boolean
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

export type PolymarketSettlementCandidate = {
  key: string
  title: string
  outcome: string
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  marketUrl?: string
}

export type PolymarketAlertCheck = {
  ok: boolean
  alerts: PolymarketAlertCandidate[]
  settlements: PolymarketSettlementCandidate[]
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

function readBoolean(position: PolymarketPosition, keys: string[]) {
  for (const key of keys) {
    const value = position[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', 'yes', '1'].includes(normalized)) return true
      if (['false', 'no', '0'].includes(normalized)) return false
    }
  }
  return false
}

function readDate(position: PolymarketPosition, keys: string[]) {
  for (const key of keys) {
    const value = position[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

function isEndedOrResolved(position: PolymarketPosition) {
  if (readBoolean(position, ['closed', 'resolved', 'settled', 'redeemable', 'mergeable'])) return true
  const endMs = readDate(position, ['endDate', 'end_date', 'resolutionDate', 'resolution_date', 'closedTime', 'closed_time'])
  return typeof endMs === 'number' && endMs <= Date.now()
}

function isOpenPosition(position: PolymarketPosition) {
  return !isEndedOrResolved(position) && ((position.currentValue ?? 0) > 0 || (position.size ?? 0) > 0)
}

function isWonSettledPosition(position: PolymarketPosition) {
  if (!isEndedOrResolved(position)) return false
  const cashPnl = position.cashPnl ?? 0
  const percentPnl = position.percentPnl ?? 0
  return cashPnl > 0 || percentPnl > 0
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
  if (!profile.polymarketAddress) return { ok: false, alerts: [], settlements: [], error: 'No Polymarket watch wallet is saved. Use /setpoly 0xPublicPolymarketWallet.' }
  try {
    const cutoff = -Math.abs(threshold(profile))
    const positions = await fetchPositions(profile.polymarketAddress)
    const alerts = positions
      .filter(position => typeof position.percentPnl === 'number' && position.percentPnl <= cutoff)
      .filter(isOpenPosition)
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
    const settlements = positions
      .filter(isWonSettledPosition)
      .map(position => ({
        key: `settled:${positionKey(position)}`,
        title: position.title ?? 'Untitled Polymarket market',
        outcome: position.outcome ?? 'Outcome',
        currentValue: position.currentValue,
        cashPnl: position.cashPnl,
        percentPnl: position.percentPnl,
        marketUrl: marketUrl(position),
      }))
    return { ok: true, alerts, settlements }
  } catch (err) {
    return { ok: false, alerts: [], settlements: [], error: err instanceof Error ? err.message : 'Could not check Polymarket positions.' }
  }
}

export function formatPolymarketAlertStatus(profile: UserProfile, config: AppConfig) {
  const ready = emailDeliveryReady(config)
  return [
    'PolyDesk email alerts',
    '',
    `Email: ${profile.email ?? 'not set'}`,
    `Wallet: ${profile.polymarketAddress ? shortAddress(profile.polymarketAddress) : 'not set'}`,
    `Status: ${profile.polymarketEmailAlertsEnabled ? 'on' : 'off'}`,
    `Trigger: open unresolved position PnL at or below -${threshold(profile)}%`,
    'Resolved wins: on',
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
    'Hash PayLink PolyDesk risk alert',
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
      `View Polymarket event: ${alert.marketUrl ?? 'https://polymarket.com/portfolio'}`,
      '',
    ].filter(Boolean) as string[]),
    'This is a monitoring alert from public Polymarket portfolio data, not financial advice. Visit Polymarket directly before deciding whether to close or adjust a position.',
  ].join('\n')
}

function alertEmailHtml(address: string, alerts: PolymarketAlertCandidate[]) {
  return [
    '<div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.5">',
    '<h2 style="margin:0 0 12px">Hash PayLink PolyDesk risk alert</h2>',
    `<p style="margin:0 0 16px;color:#4b5563">Wallet: ${escapeHtml(shortAddress(address))}<br/>Positions at or below the risk threshold: ${alerts.length}</p>`,
    ...alerts.map((alert, index) => [
      '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:0 0 12px">',
      `<p style="margin:0 0 6px;font-weight:700">${index + 1}. ${escapeHtml(alert.title.slice(0, 120))}</p>`,
      `<p style="margin:0 0 8px;color:#4b5563">${escapeHtml(alert.outcome)} - PnL ${alert.percentPnl.toFixed(2)}%</p>`,
      `<p style="margin:0 0 8px;color:#4b5563">Current value: ${escapeHtml(formatUsdc(alert.currentValue))}<br/>Cash PnL: ${escapeHtml(formatUsdc(alert.cashPnl))}</p>`,
      `<a href="${escapeHtml(alert.marketUrl ?? 'https://polymarket.com/portfolio')}" style="color:#2563eb;font-weight:700">View Polymarket event</a>`,
      '</div>',
    ].join('')),
    '<p style="font-size:12px;color:#6b7280">This is a monitoring alert from public Polymarket portfolio data, not financial advice. Visit Polymarket directly before deciding whether to close or adjust a position.</p>',
    '</div>',
  ].join('')
}

function settlementEmailText(address: string, settlements: PolymarketSettlementCandidate[]) {
  return [
    'Hash PayLink PolyDesk resolved win alert',
    '',
    `Wallet: ${shortAddress(address)}`,
    `Resolved positive positions: ${settlements.length}`,
    '',
    ...settlements.flatMap((alert, index) => [
      `${index + 1}. ${alert.title.slice(0, 120)}`,
      `${alert.outcome}${typeof alert.percentPnl === 'number' ? ` - PnL ${alert.percentPnl.toFixed(2)}%` : ''}`,
      `Cash PnL: ${formatUsdc(alert.cashPnl)}`,
      `View Polymarket event: ${alert.marketUrl ?? 'https://polymarket.com/portfolio'}`,
      '',
    ]),
    'This notice is based on public Polymarket portfolio data. Visit Polymarket directly to confirm status and redeem/settle if needed.',
  ].join('\n')
}

function settlementEmailHtml(address: string, settlements: PolymarketSettlementCandidate[]) {
  return [
    '<div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.5">',
    '<h2 style="margin:0 0 12px">Hash PayLink PolyDesk resolved win alert</h2>',
    `<p style="margin:0 0 16px;color:#4b5563">Wallet: ${escapeHtml(shortAddress(address))}<br/>Resolved positive positions: ${settlements.length}</p>`,
    ...settlements.map((alert, index) => [
      '<div style="border:1px solid #d1fae5;border-radius:10px;padding:14px;margin:0 0 12px;background:#f0fdf4">',
      `<p style="margin:0 0 6px;font-weight:700">${index + 1}. ${escapeHtml(alert.title.slice(0, 120))}</p>`,
      `<p style="margin:0 0 8px;color:#047857">${escapeHtml(alert.outcome)}${typeof alert.percentPnl === 'number' ? ` - PnL ${alert.percentPnl.toFixed(2)}%` : ''}</p>`,
      `<p style="margin:0 0 8px;color:#4b5563">Cash PnL: ${escapeHtml(formatUsdc(alert.cashPnl))}</p>`,
      `<a href="${escapeHtml(alert.marketUrl ?? 'https://polymarket.com/portfolio')}" style="color:#2563eb;font-weight:700">View Polymarket event</a>`,
      '</div>',
    ].join('')),
    '<p style="font-size:12px;color:#6b7280">This notice is based on public Polymarket portfolio data. Visit Polymarket directly to confirm status and redeem/settle if needed.</p>',
    '</div>',
  ].join('\n')
}

export async function sendDuePolymarketAlerts(userId: string, profile: UserProfile, store: ProfileStore, config: AppConfig) {
  if (!profile.polymarketEmailAlertsEnabled || !profile.email || !profile.polymarketAddress) return { sent: 0, checked: false }

  const checked = await checkPolymarketRisk(profile)
  await store.updateUser(userId, { polymarketAlertLastCheckedAt: Date.now() })
  if (!checked.ok) return { sent: 0, checked: true }

  const now = Date.now()
  const lastSent = profile.polymarketAlertLastSentByPosition ?? {}
  const due = checked.alerts.filter(alert => now - (lastSent[alert.key] ?? 0) >= ALERT_COOLDOWN_MS)
  const settlementLastSent = profile.polymarketSettlementLastSentByPosition ?? {}
  const settlementDue = checked.settlements.filter(alert => now - (settlementLastSent[alert.key] ?? 0) >= ALERT_COOLDOWN_MS)
  if (!due.length && !settlementDue.length) return { sent: 0, checked: true }

  let sent = 0
  if (due.length) {
    await sendEmail(config, {
      to: profile.email,
      subject: `PolyDesk alert: ${due.length} open position${due.length === 1 ? '' : 's'} down ${threshold(profile)}%+`,
      text: alertEmailText(profile.polymarketAddress, due),
      html: alertEmailHtml(profile.polymarketAddress, due),
    })
    sent += 1
  }
  if (settlementDue.length) {
    await sendEmail(config, {
      to: profile.email,
      subject: `PolyDesk resolved win: ${settlementDue.length} position${settlementDue.length === 1 ? '' : 's'}`,
      text: settlementEmailText(profile.polymarketAddress, settlementDue),
      html: settlementEmailHtml(profile.polymarketAddress, settlementDue),
    })
    sent += 1
  }

  const nextLastSent = { ...lastSent }
  for (const alert of due) nextLastSent[alert.key] = now
  const nextSettlementLastSent = { ...settlementLastSent }
  for (const alert of settlementDue) nextSettlementLastSent[alert.key] = now
  await store.updateUser(userId, {
    polymarketAlertLastSentByPosition: nextLastSent,
    polymarketSettlementLastSentByPosition: nextSettlementLastSent,
    polymarketAlertLastCheckedAt: now,
  })
  return { sent, checked: true }
}

export function startPolymarketAlertWorker(config: AppConfig, store: ProfileStore) {
  if (!config.emailEnabled) {
    console.log('PolyDesk email alerts disabled.')
    return
  }
  if (!emailDeliveryReady(config)) {
    console.warn('PolyDesk email alerts disabled: missing SENDGRID_API_KEY or ALERT_FROM_EMAIL.')
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

  console.log(`PolyDesk email alerts enabled; checking every ${Math.round(intervalMs / 60_000)} minutes.`)
  void run()
  setInterval(() => void run(), intervalMs)
}
