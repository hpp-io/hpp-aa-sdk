import { decodeEventLog, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  formatUserOperationRequest,
  type GetPaymasterDataParameters, type GetPaymasterDataReturnType,
  type GetPaymasterStubDataParameters, type GetPaymasterStubDataReturnType, type UserOperationReceipt,
} from "viem/account-abstraction";

// HPP paymaster (ERC-7677) client with the L3 fee protocol on top (design 12 §14):
//  - keeps the `hpp` extension of each stub response (viem drops unknown fields) so callers can show the fee before signing
//  - sends `quotedRate` back on pm_getPaymasterData so the service refuses to charge more than the user saw (fee_quote_stale)
//  - maps JSON-RPC -32000 rejections to HppPaymasterError { reason } so sendCalls can re-quote on free_exhausted / fee_quote_stale

export type HppPaymasterContext = { policyId: string; anchorId?: string; feeToken?: Address } & Record<string, unknown>;

export type HppFeeToken = { token: Address; symbol: string; decimals: number };
export type HppFeeQuote =
  | {
      mode: "sponsored";
      /** Free ops left for this anchor under a `sponsored_then_token` policy; null = not counted. */
      freeRemaining: number | null;
      /** Present when the policy will switch to token charging later — approve this address for `feeToken` while ops are still free. */
      erc20Paymaster?: Address;
      feeToken?: HppFeeToken | null;
    }
  | {
      mode: "token";
      token: Address; symbol: string; decimals: number;
      /** token base units per 1e18 wei, markup included — what the signature commits to */
      exchangeRate: bigint;
      /** upper bound the postOp may pull (maxCost × exchangeRate); null until gas is estimated */
      maxToken: bigint | null;
      treasury: Address;
      erc20Paymaster: Address;
      /** paymaster address the stub returned (= erc20Paymaster in token mode) */
      paymaster: Address;
    };

/** Rejections after which the client must start over from the stub (the paymaster address / rate may change). */
export const REQUOTE_REASONS = new Set(["free_exhausted", "fee_quote_stale"]);

export class HppPaymasterError extends Error {
  constructor(readonly reason: string, message: string, readonly code = -32000) { super(message); this.name = "HppPaymasterError"; }
}

/** Walks viem's error chain and returns the HPP paymaster `data.reason` if the failure came from pm_*. */
export function paymasterReason(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const o = cur as { reason?: unknown; data?: { reason?: unknown }; cause?: unknown };
    if (o instanceof HppPaymasterError) return o.reason;
    if (typeof o.data?.reason === "string") return o.data.reason;
    cur = o.cause;
  }
  return null;
}

type RpcResp = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: { reason?: string } } };

function parseQuote(h: unknown, paymaster: Address): HppFeeQuote | null {
  if (!h || typeof h !== "object") return null;
  const o = h as Record<string, any>;
  if (o.mode === "sponsored") return { mode: "sponsored", freeRemaining: o.freeRemaining ?? null, erc20Paymaster: o.erc20Paymaster, feeToken: o.feeToken ?? null };
  if (o.mode === "token") return {
    mode: "token", token: o.token, symbol: o.symbol, decimals: Number(o.decimals), exchangeRate: BigInt(o.exchangeRate),
    maxToken: o.maxToken ? BigInt(o.maxToken) : null, treasury: o.treasury, erc20Paymaster: o.erc20Paymaster ?? paymaster, paymaster,
  };
  return null;
}

export function createHppPaymaster(opts: { url: string; context?: HppPaymasterContext; fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  const quotes = new Map<string, HppFeeQuote>();
  const key = (a: string) => a.toLowerCase();

  async function call(method: string, params: unknown[]): Promise<Record<string, unknown>> {
    const res = await f(opts.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await res.json()) as RpcResp;
    if (j.error) throw new HppPaymasterError(j.error.data?.reason ?? "paymaster_error", j.error.message, j.error.code);
    return j.result ?? {};
  }
  const split = <T extends { chainId: number; entryPointAddress: Address; context?: unknown }>(p: T) => {
    const { chainId, entryPointAddress, context, ...op } = p;
    return { chainId, entryPointAddress, context: (context ?? {}) as Record<string, unknown>, op: op as Record<string, unknown> };
  };

  return {
    url: opts.url,
    context: opts.context,
    /** Last quote seen for a sender (stub or final). Use after sendCalls to know what the op cost. */
    lastQuote(sender: Address): HppFeeQuote | undefined { return quotes.get(key(sender)); },

    async getPaymasterStubData(p: GetPaymasterStubDataParameters): Promise<GetPaymasterStubDataReturnType> {
      const { chainId, entryPointAddress, context, op } = split(p);
      const r = await call("pm_getPaymasterStubData", [formatUserOperationRequest(op as never), entryPointAddress, toHex(chainId), { ...opts.context, ...context }]);
      const q = parseQuote(r.hpp, r.paymaster as Address);
      if (q) quotes.set(key(op.sender as string), q);
      return {
        paymaster: r.paymaster as Address, paymasterData: r.paymasterData as Hex,
        paymasterVerificationGasLimit: BigInt(r.paymasterVerificationGasLimit as string), paymasterPostOpGasLimit: BigInt(r.paymasterPostOpGasLimit as string),
        isFinal: !!r.isFinal, sponsor: r.sponsor as { name: string } | undefined,
      };
    },

    async getPaymasterData(p: GetPaymasterDataParameters): Promise<GetPaymasterDataReturnType> {
      const { chainId, entryPointAddress, context, op } = split(p);
      const prev = quotes.get(key(op.sender as string));
      const quoted = prev?.mode === "token" ? { quotedRate: prev.exchangeRate.toString() } : {};
      const r = await call("pm_getPaymasterData", [formatUserOperationRequest(op as never), entryPointAddress, toHex(chainId), { ...opts.context, ...context, ...quoted }]);
      const q = parseQuote(r.hpp, r.paymaster as Address);
      if (q) quotes.set(key(op.sender as string), q.mode === "token" && prev?.mode === "token" ? { ...q, maxToken: q.maxToken ?? prev.maxToken } : q);
      return { paymaster: r.paymaster as Address, paymasterData: r.paymasterData as Hex };
    },
  };
}
export type HppPaymaster = ReturnType<typeof createHppPaymaster>;

const sponsoredAbi = parseAbi(["event UserOperationSponsored(bytes32 indexed userOpHash, address indexed user, uint8 paymasterMode, address token, uint256 tokenAmountPaid, uint256 exchangeRate)"]);

/** Token actually charged for a userOp (from SingletonPaymaster's UserOperationSponsored log). null when not a token-mode op. */
export function chargedTokenFromReceipt(receipt: UserOperationReceipt, paymaster: Address, userOpHash: Hex): bigint | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== paymaster.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: sponsoredAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === "UserOperationSponsored" && (d.args.userOpHash as Hex).toLowerCase() === userOpHash.toLowerCase() && Number(d.args.paymasterMode) === 1) return d.args.tokenAmountPaid as bigint;
    } catch { /* other event */ }
  }
  return null;
}

/** Fee summary attached to SendResult. */
export type FeeInfo =
  | { mode: "self" }
  | { mode: "sponsored"; freeRemaining: number | null }
  | { mode: "token"; token: Address; symbol: string; decimals: number; exchangeRate: bigint; maxToken: bigint | null; charged: bigint | null };

export function feeInfoOf(pm: HppPaymaster | undefined, sender: Address, receipt: UserOperationReceipt, userOpHash: Hex): FeeInfo {
  const q = pm?.lastQuote(sender);
  if (!q) return { mode: "self" };
  if (q.mode === "sponsored") return { mode: "sponsored", freeRemaining: q.freeRemaining };
  return { mode: "token", token: q.token, symbol: q.symbol, decimals: q.decimals, exchangeRate: q.exchangeRate, maxToken: q.maxToken, charged: chargedTokenFromReceipt(receipt, q.paymaster, userOpHash) };
}
