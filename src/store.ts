import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRegistration, PaymentRequest, PendingStreamRequest, StreamRequest } from './hashpaylink.js'

export type UserProfile = {
  evmAddress?: string
  solanaAddress?: string
  polymarketAddress?: string
  polymarketFundingAddress?: string
  email?: string
  polymarketEmailAlertsEnabled?: boolean
  polymarketAlertThresholdPercent?: number
  polymarketAlertLastSentByPosition?: Record<string, number>
  polymarketSettlementLastSentByPosition?: Record<string, number>
  polymarketAlertLastCheckedAt?: number
  defaultNetwork?: 'base' | 'arbitrum' | 'solana'
  latestRequest?: PaymentRequest
  recentRequests?: PaymentRequest[]
  recentAiRequests?: PaymentRequest[]
  recentLpRequests?: PaymentRequest[]
  recentStreams?: StreamRequest[]
  pendingStreams?: PendingStreamRequest[]
  circleWalletProvisioning?: {
    agentSlug: string
    email: string
    requestId?: string
    testnet?: boolean
    createdAt: number
  }
  botMessagesByChat?: Record<string, number[]>
}

export type StoreData = {
  users: Record<string, UserProfile>
  agents?: Record<string, AgentRegistration>
  platform?: {
    evmAddress?: string
    solanaAddress?: string
    paidAiPriceUsdc?: string
    polymarketLpPriceUsdc?: string
  }
}

const DEFAULT_DATA: StoreData = { users: {} }
const UPSTASH_REST_URL = (process.env.UPSTASH_REDIS_REST_URL ?? '').trim().replace(/\/+$/, '')
const UPSTASH_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim()
const UPSTASH_STORE_KEY = (process.env.UPSTASH_PROFILE_STORE_KEY ?? 'hashpaylink:photon:profiles').trim()

async function upstashCommand<T>(command: unknown[]): Promise<T | undefined> {
  if (!UPSTASH_REST_URL || !UPSTASH_REST_TOKEN) return undefined
  const response = await fetch(UPSTASH_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  if (!response.ok) throw new Error(`Upstash request failed: ${response.status}`)
  const data = await response.json() as { result?: T }
  return data.result
}

export class ProfileStore {
  private data: StoreData = DEFAULT_DATA

  constructor(private readonly filePath: string) {}

  async load() {
    const remote = await this.loadFromUpstash()
    if (remote) {
      this.data = remote
      return
    }
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.data = JSON.parse(raw) as StoreData
    } catch {
      this.data = { users: {} }
    }
  }

  getUser(userId: string): UserProfile {
    return this.data.users[userId] ?? {}
  }

  getAgent(slug: string) {
    return this.data.agents?.[slug]
  }

  listAgents() {
    return Object.values(this.data.agents ?? {})
  }

  getPlatform() {
    return this.data.platform ?? {}
  }

  listUsers() {
    return Object.entries(this.data.users)
  }

  async updatePlatform(patch: StoreData['platform']) {
    this.data.platform = { ...(this.data.platform ?? {}), ...patch }
    await this.save()
    return this.data.platform
  }

  async upsertAgent(agent: AgentRegistration) {
    this.data.agents = { ...(this.data.agents ?? {}), [agent.slug]: agent }
    await this.save()
    return agent
  }

  async updateUser(userId: string, patch: UserProfile) {
    this.data.users[userId] = { ...this.getUser(userId), ...patch }
    await this.save()
    return this.data.users[userId]
  }

  async addBotMessage(userId: string, chatId: string, messageId: number) {
    const profile = this.getUser(userId)
    const messagesByChat = { ...(profile.botMessagesByChat ?? {}) }
    const messages = [...(messagesByChat[chatId] ?? []), messageId]
    messagesByChat[chatId] = messages
    await this.updateUser(userId, { botMessagesByChat: messagesByChat })
  }

  async clearBotMessages(userId: string, chatId: string) {
    const profile = this.getUser(userId)
    const messages = [...(profile.botMessagesByChat?.[chatId] ?? [])]
    const messagesByChat = { ...(profile.botMessagesByChat ?? {}) }
    delete messagesByChat[chatId]
    await this.updateUser(userId, { botMessagesByChat: messagesByChat })
    return messages
  }

  private async save() {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2))
    await this.saveToUpstash()
  }

  private async loadFromUpstash() {
    try {
      const raw = await upstashCommand<string>(['GET', UPSTASH_STORE_KEY])
      if (!raw) return undefined
      return JSON.parse(raw) as StoreData
    } catch (error) {
      console.warn('[store] Upstash load failed; using local file fallback.', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  private async saveToUpstash() {
    try {
      await upstashCommand(['SET', UPSTASH_STORE_KEY, JSON.stringify(this.data)])
    } catch (error) {
      console.warn('[store] Upstash save failed; local file was saved.', error instanceof Error ? error.message : String(error))
    }
  }
}
