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
/request 25 USDC for event ticket on solana
/request 25 USDC for invoice on arbitrum
/setpoly 0xYourPolymarketWallet
/poly
/lp best
/answer your-payer-name
/askpaid What should I build for the 0G hackathon?
/answer your-payer-name
/verifyagent marketbot https://api.marketbot.xyz/ask price=2
/setagentprice marketbot 5
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

`/clear` removes tracked messages sent by the Hash PayLink bot for the initiating user in the current chat. Telegram only lets the bot delete messages it sent, so user messages may remain.

### Command Groups

**Instant Payments**

Use `/request` for normal one-time Hash PayLink collections. Payments are tracked through the Hash PayLink dashboard and archived to 0G when the main backend records the payment.

Base is the default network. Add `on solana` or `on arbitrum` to route a single request to that chain, for example `/request 4 USDC for relayer on solana`. Legacy `net=solana` / `net=arbitrum` overrides still work.

**WhatsApp Payments**

WhatsApp is intentionally limited to one-time Hash PayLink payment requests and tracking. It supports `/request`, `/requests`, `/status`, `/remind`, and `/help`; AI access, agent registration, and StreamPay stay Telegram-only for now.

**Polymarket Watchlist and Paid LP Scout**

Telegram users can save a public Polymarket wallet for read-only portfolio watching:

```text
/setpoly 0xYourPolymarketWallet
/poly
```

Polymarket LP Scout is paid access:

```text
/lp best
/lp crypto
/lpmarket polymarket-url-or-slug
/answer your-payer-name
```

`/setpoly` saves the user's public Polymarket wallet for portfolio lookup. `/poly` reads public Polymarket positions/value for the saved wallet. The bot does not create Polymarket funding links, bridge deposits, or deposit instructions.

`/lp best` creates a Hash PayLink paid access request. After payment, `/answer <payer-name>` unlocks the scan: active Polymarket reward markets, live order books where token IDs are available, longer-duration scoring, daily rewards, max spread, min size, live spread, suggested YES/NO quote levels, LP execution risk, and outcome risk. `/lp crypto` filters by topic. `/lpmarket` inspects one market URL or slug. These commands are educational product signals only; they do not guarantee fills, rewards, badges, profit, or market outcomes.

Admins can set the LP Scout price from Telegram:

```text
/setlpprice 1
```

**AI Paid Access**

Use `/askpaid` to create a payment-gated question for the built-in Hash PayLink Circle/Arc/Polymarket Strategy AI endpoint. The PayLink is paid to the configured Hash PayLink recipient wallet, not to the caller's wallet. After the payer completes the PayLink, they can run `/answer <payer-name>` or reply `I paid as <payer-name>` using the payer name entered on the payment page. The bot verifies payment through Hash PayLink's 0G proof endpoint before returning the answer.

The built-in paid AI recipient can be set from Telegram by an admin:

```text
/me
/setpaid evm 0xYourHashPayLinkWallet
/setpaid price 1
/paidsettings
```

Users can still override the built-in AI price for a single request by including the amount:

```text
/askpaid 2 USDC What should I build for Arc?
```

Use `/verifyagent` to register a public HTTPS agent endpoint. The bot performs a basic endpoint health check and activates the agent if it responds. Users can then call `/askagent <name> <question>` to create a paid access request for that external agent. Agent access payments route to the agent owner's saved wallet. If the agent owner has not set `/setevm`, `/askagent` is blocked instead of falling back to the Hash PayLink platform wallet.

Agent owners can update their default price without re-registering:

```text
/setagentprice marketbot 5
```

**Arc Streaming**

Use `/stream` to create an Arc StreamPay launch link. The StreamPay UI opens with amount, recipient, duration, and reason prefilled; wallet signing and vault deployment still happen in StreamPay.

## Environment

Copy `.env.example` to `.env` and fill:

```env
HASH_PAYLINK_BASE_URL=https://hashpaylink.com
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=
PHOTON_PROJECT_ID=
PHOTON_SECRET_KEY=
ADMIN_USER_IDS=
DEFAULT_EVM_ADDRESS=
DEFAULT_SOLANA_ADDRESS=
DEFAULT_NETWORK=base
STORE_PATH=./data/profiles.json

# Optional WhatsApp Business Cloud API transport.
WHATSAPP_ENABLED=false
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_GRAPH_VERSION=v20.0
PORT=3000
```

`ADMIN_USER_IDS` is a comma-separated list of Telegram user IDs allowed to run `/setpaid` and `/paidsettings`. Send `/me` to the bot to see your Telegram user ID.

`DEFAULT_EVM_ADDRESS` and `DEFAULT_SOLANA_ADDRESS` are optional bootstrap fallback addresses. The built-in paid AI recipient can be updated from Telegram with `/setpaid`. Public users should save their own recipient addresses in Telegram for normal payment requests:

```text
/setevm 0xYourAddress
/setsol YourSolanaAddress
```

Use public recipient addresses only. Never store private keys in this agent.

For WhatsApp setup, create a Meta Developer app with WhatsApp Business enabled, then point the WhatsApp webhook to:

```text
https://YOUR_AGENT_HOST/webhook/whatsapp
```

Use the same value from `WHATSAPP_VERIFY_TOKEN` when Meta asks for the webhook verify token. WhatsApp payment requests rely on `DEFAULT_EVM_ADDRESS` or `DEFAULT_SOLANA_ADDRESS` because wallet setup commands remain Telegram-only.

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

WhatsApp chat
  -> Hash PayLink Photon Agent
  -> Hash PayLink Multi-Payer Collection URL only
  -> payer completes payment on hashpaylink.com
```

No custody. No private keys. No payment execution inside Telegram.
