import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PaymentRequest } from './hashpaylink.js'

export type UserProfile = {
  evmAddress?: string
  solanaAddress?: string
  defaultNetwork?: 'base' | 'arbitrum' | 'solana'
  latestRequest?: PaymentRequest
  recentRequests?: PaymentRequest[]
  botMessagesByChat?: Record<string, number[]>
}

export type StoreData = {
  users: Record<string, UserProfile>
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

  async updateUser(userId: string, patch: UserProfile) {
    this.data.users[userId] = { ...this.getUser(userId), ...patch }
    await this.save()
    return this.data.users[userId]
  }

  async addBotMessage(userId: string, chatId: string, messageId: number) {
    const profile = this.getUser(userId)
    const messagesByChat = { ...(profile.botMessagesByChat ?? {}) }
    const messages = [...(messagesByChat[chatId] ?? []), messageId]
    messagesByChat[chatId] = messages.slice(-30)
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
