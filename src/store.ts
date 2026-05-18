import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRegistration, PaymentRequest, PendingStreamRequest, StreamRequest } from './hashpaylink.js'

export type UserProfile = {
  evmAddress?: string
  solanaAddress?: string
  polymarketAddress?: string
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

export class ProfileStore {
  private data: StoreData = DEFAULT_DATA

  constructor(private readonly filePath: string) {}

  async load() {
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
  }
}
