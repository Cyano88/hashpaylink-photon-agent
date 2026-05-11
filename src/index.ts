import { loadConfig } from './config.js'
import { runTelegramBot } from './telegram.js'

const config = loadConfig()

if (config.photonProjectId && config.photonSecretKey) {
  console.log('Photon credentials detected; Spectrum provider wiring can be enabled when Telegram provider access is available.')
}

await runTelegramBot(config)
