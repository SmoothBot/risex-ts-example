import { ethers } from "ethers";

export interface PermitParams {
  account: string;
  signer: string;
  nonce: string;
  deadline: string;
  signature: string;
}

export interface OrderParams {
  market_id: string;
  size: string;
  price: string;
  side: number;
  order_type: number;
  tif: number;
  post_only: boolean;
  reduce_only: boolean;
  stp_mode: number;
  expiry: number;
}

export interface Market {
  market_id: string;
  display_name: string;
  base_asset_symbol: string;
  quote_asset_symbol: string;
  last_price: string;
  mark_price: string;
  index_price: string;
  visible: boolean;
  post_only: boolean;
  config: {
    min_order_size: string;
    step_size: string;
    step_price: string;
    max_leverage: string;
    [k: string]: any;
  };
  [k: string]: any;
}

export class RiseClient {
  private baseUrl: string;
  private accountWallet: ethers.Wallet;
  private signerWallet: ethers.Wallet;
  private domain!: { name: string; version: string; chainId: bigint; verifyingContract: string };
  private target!: string; // orders_manager contract

  readonly account: string;
  readonly signer: string;

  constructor(opts: { baseUrl?: string; accountKey: string; signerKey: string }) {
    this.baseUrl = opts.baseUrl || "https://api.testnet.rise.trade";
    this.accountWallet = new ethers.Wallet(opts.accountKey);
    this.signerWallet = new ethers.Wallet(opts.signerKey);
    this.account = this.accountWallet.address;
    this.signer = this.signerWallet.address;
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  async init() {
    const domainRes = this.unwrap(await this.api("GET", "/v1/auth/eip712-domain"));
    this.domain = {
      name: domainRes.name,
      version: domainRes.version,
      chainId: BigInt(domainRes.chain_id),
      verifyingContract: domainRes.verifying_contract,
    };

    const config = this.unwrap(await this.api("GET", "/v1/system/config"));
    this.target =
      config.addresses?.perp_v2?.orders_manager ||
      config.contract_addresses?.perps_manager;
    if (!this.target) throw new Error("Could not find orders_manager in system config");

    return this;
  }

  // ─── Auth ──────────────────────────────────────────────────────────────

  async isSignerRegistered(): Promise<boolean> {
    const res = this.unwrap(
      await this.api("GET", `/v1/auth/session-key-status?account=${this.account}&signer=${this.signer}`)
    );
    return res.status === 1;
  }

  async registerSigner(): Promise<any> {
    if (await this.isSignerRegistered()) return { alreadyActive: true };

    const nonce = this.createNonce();
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const message = "RISEx Signer Registration";

    const accountSig = this.fixV(
      await this.accountWallet.signTypedData(this.domain, {
        RegisterSigner: [
          { name: "signer", type: "address" },
          { name: "message", type: "string" },
          { name: "expiration", type: "uint40" },
          { name: "nonce", type: "uint256" },
        ],
      }, { signer: this.signer, message, expiration, nonce })
    );

    const signerSig = this.fixV(
      await this.signerWallet.signTypedData(this.domain, {
        VerifySigner: [
          { name: "account", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      }, { account: this.account, nonce })
    );

    return this.api("POST", "/v1/auth/register-signer", {
      account: this.account,
      signer: this.signer,
      message, nonce, expiration,
      account_signature: accountSig,
      signer_signature: signerSig,
      label: "rise-bot",
    });
  }

  // ─── Market Data ───────────────────────────────────────────────────────

  async getMarkets(): Promise<Market[]> {
    const data = this.unwrap(await this.api("GET", "/v1/markets"));
    return data.markets || [];
  }

  async getOrderbook(marketId: number, limit = 5) {
    return this.unwrap(await this.api("GET", `/v1/orderbook?market_id=${marketId}&limit=${limit}`));
  }

  // ─── Account ───────────────────────────────────────────────────────────

  async getBalance(): Promise<string> {
    const data = this.unwrap(await this.api("GET", `/v1/account/cross-margin-balance?account=${this.account}`));
    return data.balance;
  }

  async getEquity(): Promise<string> {
    const data = this.unwrap(await this.api("GET", `/v1/account/equity?account=${this.account}`));
    return data.equity;
  }

  async getPosition(marketId: number) {
    const data = this.unwrap(
      await this.api("GET", `/v1/account/position?market_id=${marketId}&account=${this.account}`)
    );
    return data.position;
  }

  // ─── Orders ────────────────────────────────────────────────────────────

  async placeOrder(orderParams: OrderParams): Promise<any> {
    const encoded = this.encodeOrder(orderParams);
    const hash = ethers.keccak256(encoded);
    const permit = await this.signPermit(hash);

    return this.api("POST", "/v1/orders/place", {
      order_params: orderParams,
      permit_params: permit,
    });
  }

  async marketBuy(marketId: number, size: bigint): Promise<any> {
    return this.placeOrder({
      market_id: String(marketId),
      size: size.toString(),
      price: "0",
      side: 0,
      order_type: 0,
      tif: 3,
      post_only: false,
      reduce_only: false,
      stp_mode: 0,
      expiry: 0,
    });
  }

  async marketSell(marketId: number, size: bigint, reduceOnly = false): Promise<any> {
    return this.placeOrder({
      market_id: String(marketId),
      size: size.toString(),
      price: "0",
      side: 1,
      order_type: 0,
      tif: 3,
      post_only: false,
      reduce_only: reduceOnly,
      stp_mode: 0,
      expiry: 0,
    });
  }

  async closePosition(marketId: number): Promise<any> {
    const pos = await this.getPosition(marketId);
    if (!pos || pos.size === "0") return null;

    const size = (() => { const s = BigInt(pos.size); return s < 0n ? -s : s; })();
    const isLong = pos.side === 0;
    return isLong
      ? this.marketSell(marketId, size, true)
      : this.marketBuy(marketId, size);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async api(method: string, path: string, body?: any): Promise<any> {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${path}`, opts);
    const json = await res.json();
    if (!res.ok) {
      const msg = (json as any).message || (json as any).error?.message || res.statusText;
      throw new Error(`API ${method} ${path} → ${res.status}: ${msg}`);
    }
    return json;
  }

  private unwrap(json: any): any {
    return json.data ?? json;
  }

  private async signPermit(hash: string): Promise<PermitParams> {
    const nonce = this.createNonce();
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const signature = this.fixV(
      await this.signerWallet.signTypedData(this.domain, {
        VerifySignature: [
          { name: "account", type: "address" },
          { name: "target", type: "address" },
          { name: "hash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      }, { account: this.account, target: this.target, hash, nonce, deadline })
    );

    return { account: this.account, signer: this.signer, nonce, deadline: String(deadline), signature };
  }

  private encodeOrder(p: OrderParams): Uint8Array {
    const buf = new Uint8Array(47);
    const view = new DataView(buf.buffer);

    view.setBigUint64(0, BigInt(p.market_id));

    const sizeHex = BigInt(p.size).toString(16).padStart(32, "0");
    for (let i = 0; i < 16; i++) buf[8 + i] = parseInt(sizeHex.slice(i * 2, i * 2 + 2), 16);

    const priceHex = BigInt(p.price).toString(16).padStart(32, "0");
    for (let i = 0; i < 16; i++) buf[24 + i] = parseInt(priceHex.slice(i * 2, i * 2 + 2), 16);

    buf[40] = (p.side & 1) | (p.post_only ? 2 : 0) | (p.reduce_only ? 4 : 0);
    buf[41] = p.order_type;
    buf[42] = p.tif;
    view.setUint32(43, p.expiry);

    return buf;
  }

  private createNonce(): string {
    const rand6 = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const base = `${Date.now()}${rand6}`;
    const sec = base.slice(0, -9);
    const input = `${sec}${this.account.toLowerCase()}`;
    let h = 0;
    for (let i = 0; i < input.length; i++) h = ((h * 31 + input.charCodeAt(i)) & 0xffffffff) >>> 0;
    return base.slice(0, -6) + String(h).slice(-6).padStart(6, "0");
  }

  private fixV(sig: string): string {
    const bytes = ethers.getBytes(sig);
    if (bytes.length === 65 && bytes[64] < 27) bytes[64] += 27;
    return ethers.hexlify(bytes);
  }
}

/** Format a value that may be WAD (18-decimal bigint string) or already a decimal string. */
export function formatWad(s: string): string {
  if (!s) return "0";
  if (s.includes(".")) return s;
  try { return ethers.formatUnits(s, 18); } catch { return s; }
}
