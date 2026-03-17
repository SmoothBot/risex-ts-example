# rise-bot

TypeScript client for the [RISEx](https://rise.trade) perpetual futures API (testnet).

## Setup

```bash
npm install
cp .env.example .env
# Fill in ACCOUNT_PRIVATE_KEY and SIGNER_PRIVATE_KEY
```

You need two separate private keys:
- **Account key** — your main wallet that holds funds
- **Signer key** — a session key for signing trades (auto-registered on first run)

## Usage

```bash
npx tsx src/test-api.ts
```

This fetches markets, reads the orderbook, opens a min-size ETH long, then closes it.

## Client API

```typescript
import { RiseClient } from "./src/rise-client.js";

const client = new RiseClient({ accountKey: "0x...", signerKey: "0x..." });
await client.init();
await client.registerSigner();

const markets = await client.getMarkets();
const book = await client.getOrderbook(2); // ETH
const balance = await client.getBalance();

await client.marketBuy(2, BigInt("20000000000000000")); // 0.02 ETH
await client.marketSell(2, BigInt("20000000000000000"));
await client.closePosition(2);
```
