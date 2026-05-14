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
/askpaid 1 USDC What should I build for the 0G hackathon?
/answer <request-id> <payer-name>
/verifyagent marketbot https://api.marketbot.xyz/ask price=2
/askagent marketbot Analyze BTC risk this week
/agents
/stream 100 USDC to 0xRecipient for 7d reason="research retainer"
/streams
/me
/requests
/status
/status <request-id>
/remind
/remind <request-id>
/clear
/help
```

Send `/setevm` or `/setsol` without an address to open a reply prompt. Then paste only the wallet address and send.

`/clear` removes recent messages sent by the Hash PayLink bot in the current chat. Telegram only lets the bot delete messages it sent, so user messages may remain.

### Command Groups

**Instant Payments**

Use `/request` for normal one-time Hash PayLink collections. Payments are tracked through the Hash PayLink dashboard and archived to 0G when the main backend records the payment.

**AI Paid Access**

Use `/askpaid` to create a payment-gated question for the built-in Hash PayLink Circle/Arc Strategy AI endpoint. After the payer completes the PayLink, run `/answer <request-id> <payer-name>` using the payer name entered on the payment page. The bot verifies payment through Hash PayLink's 0G proof endpoint before returning the answer.

Use `/verifyagent` to register a public HTTPS agent endpoint. The bot performs a basic endpoint health check and activates the agent if it responds. Users can then call `/askagent <name> <question>` to create a paid access request for that external agent.

**Arc Streaming**

Use `/stream` to create an Arc StreamPay launch link. The StreamPay UI opens with amount, recipient, duration, and reason prefilled; wallet signing and vault deployment still happen in StreamPay.

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
  -> Hash PayLink Multi-Payer Collection / AI access / Arc StreamPay URL
  -> payer completes payment or stream setup on hashpaylink.com
  -> 0G proof verification for paid AI access
```

No custody. No private keys. No payment execution inside Telegram.
