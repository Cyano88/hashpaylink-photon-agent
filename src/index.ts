import { loadConfig } from './config.js'
import { runTelegramBot } from './telegram.js'
import { ProfileStore } from './store.js'

const config = loadConfig()
const store = new ProfileStore(config.storePath)
await store.load()

if (config.photonProjectId && config.photonSecretKey) {
  console.log('Photon credentials detected; Spectrum provider wiring can be enabled when Telegram provider access is available.')
}

await runTelegramBot(config, store)
