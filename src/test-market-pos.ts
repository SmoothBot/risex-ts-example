import "dotenv/config";
import { RiseClient, formatWad } from "./rise-client.js";

const client = new RiseClient({
  accountKey: process.env.ACCOUNT_PRIVATE_KEY!,
  signerKey: process.env.SIGNER_PRIVATE_KEY!,
  baseUrl: process.env.API_URL,
});

async function main() {
  console.log("=== RISEx API Test ===");
  console.log("Account:", client.account);
  console.log("Signer:", client.signer);

  await client.init();
  await client.registerSigner();
  console.log();

  // Fetch markets
  const markets = await client.getMarkets();
  console.log(`--- ${markets.length} Markets ---`);
  for (const m of markets.slice(0, 10)) {
    console.log(`  ${m.market_id}: ${m.display_name}  last=${m.last_price}  mark=${m.mark_price}`);
  }

  const market = markets.find((m) => m.visible && m.base_asset_symbol?.includes("ETH"))
    || markets.find((m) => m.visible);
  if (!market) throw new Error("No visible market found");

  const marketId = Number(market.market_id);
  const minSize = BigInt(market.config.min_order_size);
  console.log(`\nUsing ${market.display_name} (id=${marketId}), min size=${formatWad(minSize.toString())}`);

  // Orderbook
  const book = await client.getOrderbook(marketId);
  console.log("\n--- Orderbook ---");
  console.log("Bids:", (book.bids || []).slice(0, 3).map((b: any) => `${b.price} x ${b.quantity}`).join("  "));
  console.log("Asks:", (book.asks || []).slice(0, 3).map((a: any) => `${a.price} x ${a.quantity}`).join("  "));

  // Balance
  console.log(`\nBalance: ${formatWad(await client.getBalance())} USDC`);

  // Open position
  console.log("\n--- Market Buy ---");
  const buyResult = await client.marketBuy(marketId, minSize);
  console.log("Order:", buyResult.data?.order_id, "tx:", buyResult.data?.transaction_hash);

  await new Promise((r) => setTimeout(r, 3000));

  // Check position
  const pos = await client.getPosition(marketId);
  console.log("Position:", pos?.size !== "0" ? `${formatWad(pos.size)} ${pos.side === 0 ? "Long" : "Short"}` : "none");

  // Close position
  console.log("\n--- Closing Position ---");
  const closeResult = await client.closePosition(marketId);
  if (closeResult) {
    console.log("Order:", closeResult.data?.order_id, "tx:", closeResult.data?.transaction_hash);
  } else {
    console.log("No position to close");
  }

  await new Promise((r) => setTimeout(r, 3000));

  // Final state
  const finalPos = await client.getPosition(marketId);
  console.log("\nFinal position:", finalPos?.size !== "0" ? formatWad(finalPos.size) : "closed");
  console.log("Final balance:", formatWad(await client.getBalance()), "USDC");
  console.log("\n=== Done ===");
}

main().catch(console.error);
