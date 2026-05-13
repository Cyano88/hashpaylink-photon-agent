# Hash PayLink Photon Agent

Photon-ready Telegram agent for creating and tracking Hash PayLink USDC multi-payer collections from chat.

The agent does not custody funds, sign payments, or hold private keys. It creates Hash PayLink payment actions and sends compact Pay/Track buttons back to the user in Telegram. Payment execution remains inside Hash PayLink.

Bot replies include the footer `Built for Photon - Powered by Hash PayLink` to keep Photon positioning visible while staying honest about the current Telegram transport.

## Commands

`/request` creates a Hash PayLink Multi-Payer Collection by default.

```text
/setevm 0xYourAddress
/setsol YourSolanaAddress
/network base
/request 10 USDC for design work
/request 25 USDC for event ticket net=solana
/me
/requests
/status
/status <request-id>
/help
```

## Environment

Copy `.env.example` to `.env` and fill:

```env
HASH_PAYLINK_BASE_URL=https://hashpaylink.com
TELEGRAM_BOT_TOKEN=
PHOTON_PROJECT_ID=
PHOTON_SECRET_KEY=
DEFAULT_EVM_ADDRESS=
DEFAULT_SOLANA_ADDRESS=
DEFAULT_NETWORK=base
STORE_PATH=./data/profiles.json
```

`DEFAULT_EVM_ADDRESS` and `DEFAULT_SOLANA_ADDRESS` are optional fallback addresses. Public users should save their own recipient addresses in Telegram:

```text
/setevm 0xYourAddress
/setsol YourSolanaAddress
```

Use public recipient addresses only. Never store private keys in this agent.

## Run Locally

```bash
npm install
npm run dev
```

Open your Telegram bot and send:

```text
/setevm 0xYourAddress
/request 1 USDC for test
```

## Build

```bash
npm run build
npm run start
```

## Photon Grant Positioning

Hash PayLink Photon Agent brings non-custodial USDC collection requests into messaging. Merchants can create multi-payer payment links from chat, share them in groups, and track payer logs through Hash PayLink's existing collection dashboard.

Photon credentials are included as first-class configuration so the same command layer can be wired to Photon Spectrum providers as Telegram access becomes available.

## Minimal Architecture

```text
Telegram chat
  -> Hash PayLink Photon Agent
  -> Hash PayLink Multi-Payer Collection URL
  -> payer completes payment on hashpaylink.com
```

No custody. No private keys. No payment execution inside Telegram.
