import { encodeFunctionData, pad, parseAbi, toHex, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { readContract } from "viem/actions";
import type { BundlerClient, SmartAccount } from "viem/account-abstraction";
import { getUniversalActionPolicy } from "@rhinestone/module-sdk";
import type { Call } from "./kernel.js";
import { paymasterReason, REQUOTE_REASONS, type HppFeeQuote, type HppPaymaster } from "./paymaster.js";
import type { ActionSpec } from "./sessions.js";

// Paying gas in a token: approve the ERC-20 paymaster INSIDE the operation that pays (design 23).
//
// The paymaster pulls the fee with transferFrom in postOp, after the op's own calls have run — so an approve placed
// first in the same op is in effect by the time it collects. That is how the Pimlico, Alchemy and Coinbase SDKs pay
// gas in a token, and it removes two failure modes of "approve once, while ops are free": a user who missed that
// moment, and a session agent, which has no way to approve ahead of time. Each op approves only what it may be
// charged (plus headroom), so no large standing allowance sits on the account.

const erc20Abi = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);

export const approveCall = (token: Address, spender: Address, amount: bigint): Call =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });

/**
 * The approve to prepend to a token-mode op, or null when the allowance already covers it.
 *
 * `maxCostWei` is the op's gas ceiling (Σ gas limits × maxFeePerGas) — what the paymaster prices. The amount is 1.5×
 * that in tokens: the send re-estimates gas after this quote (preVerificationGas follows the L1 data price), and an
 * approve that lands short is rejected as fee_allowance_missing. What is left after the charge is about half of one
 * op's maximum fee — and the next op reuses it instead of approving again.
 */
export function feeApprovalCall(p: {
  token: Address; spender: Address; decimals: number; exchangeRate: bigint; maxCostWei: bigint; allowance: bigint;
}): Call | null {
  let maxToken = (p.maxCostWei * p.exchangeRate) / 10n ** 18n;
  // The service never quotes below a minimum fee (0.001 token by default) — never approve less than that.
  const floor = 10n ** BigInt(Math.max(0, p.decimals - 3));
  if (maxToken < floor) maxToken = floor;
  if (p.allowance >= maxToken + maxToken / 4n) return null;
  return approveCall(p.token, p.spender, maxToken + maxToken / 2n);
}

export type FeeCtx = {
  bundler: BundlerClient<Transport, Chain, SmartAccount | undefined>;
  account: SmartAccount;
  client: PublicClient<Transport, Chain>;
  paymaster: HppPaymaster | undefined;
  chain: Chain;
  sender: Address;
};

type GasPrice = { suggested: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
export async function gasPrice(bundler: FeeCtx["bundler"]) {
  const r = (await bundler.request({ method: "rundler_getUserOperationGasPrice" as never, params: [] as never })) as GasPrice;
  return { maxFeePerGas: BigInt(r.suggested.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.suggested.maxPriorityFeePerGas) };
}

// A policy that answered "sponsored, nothing to approve, no free counter" never charges a token — skip the extra
// stub round trip on that client from then on.
const neverToken = new WeakSet<HppPaymaster>();

export type FeePlan = {
  /** What to send: `calls`, with approve(paymaster, amount) first when the op will be charged a token the allowance doesn't cover. */
  calls: Call[];
  /** The paymaster's quote for this op; undefined when there is no HPP paymaster. */
  quote: HppFeeQuote | undefined;
  /** Token mode: the most this op can be charged, in token units (priced with the approve in place). */
  maxToken?: bigint;
};

/**
 * Price an op and decide whether it needs a fee approve in front.
 *
 * The op is priced with the approve already in place, using a small placeholder amount: a session agent's approve is
 * capped per call by its session policy (design 23 §3.4), and a placeholder above that cap would make the estimate
 * itself fail validation. The placeholder changes calldata by a couple of bytes — far inside the 1.5× headroom.
 */
export async function planFee(ctx: FeeCtx, calls: Call[]): Promise<FeePlan> {
  const pm = ctx.paymaster;
  if (!pm || neverToken.has(pm)) return { calls, quote: undefined };
  const fees = await gasPrice(ctx.bundler);
  const stub = await pm.getPaymasterStubData({
    // empty calls = "which mode / token would apply?" — Kernel cannot encode an empty batch, and there is nothing to estimate
    sender: ctx.sender, nonce: await ctx.account.getNonce(), callData: calls.length ? await ctx.account.encodeCalls(calls) : "0x",
    ...fees, signature: await ctx.account.getStubSignature(), chainId: ctx.chain.id, entryPointAddress: ctx.account.entryPoint.address,
  } as never);
  const q = pm.lastQuote(ctx.sender);
  if (!q || q.mode !== "token") {
    if (q?.mode === "sponsored" && !q.erc20Paymaster && !q.feeToken && q.freeRemaining === null) neverToken.add(pm);
    return { calls, quote: q };
  }
  if (calls.length === 0) return { calls, quote: q };
  const placeholder = approveCall(q.token, q.paymaster, 10n ** BigInt(Math.max(0, q.decimals - 1)));
  const est = await ctx.bundler.estimateUserOperationGas({
    account: ctx.account, calls: [placeholder, ...calls], ...fees,
    paymaster: stub.paymaster, paymasterData: stub.paymasterData,
    paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit, paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit,
  } as never);
  const pmVer = est.paymasterVerificationGasLimit ?? stub.paymasterVerificationGasLimit ?? 0n;
  const pmPost = est.paymasterPostOpGasLimit ?? stub.paymasterPostOpGasLimit ?? 0n;
  const maxCostWei = (est.verificationGasLimit + est.callGasLimit + est.preVerificationGas + pmVer + pmPost) * fees.maxFeePerGas;
  const allowance = await readContract(ctx.client, { address: q.token, abi: erc20Abi, functionName: "allowance", args: [ctx.sender, q.paymaster] });
  const approve = feeApprovalCall({ token: q.token, spender: q.paymaster, decimals: q.decimals, exchangeRate: q.exchangeRate, maxCostWei, allowance });
  return { calls: approve ? [approve, ...calls] : calls, quote: q, maxToken: (maxCostWei * q.exchangeRate) / 10n ** 18n };
}

/** Server reasons after which the op is rebuilt from a fresh quote (design 12 §14, design 23 §3.2). */
const REPLAN_REASONS = new Set([...REQUOTE_REASONS, "fee_allowance_missing"]);

/**
 * Send `calls` as one op, approving the fee in the same op when it is charged in a token.
 *
 * free_exhausted (the free op was used up between quote and signature), fee_quote_stale (the rate moved) and
 * fee_allowance_missing (gas was re-estimated above the approved headroom) all mean "plan again from a fresh quote" —
 * the next plan sees the new mode, rate or allowance and approves accordingly.
 */
export async function sendWithFee(ctx: FeeCtx, calls: Call[], attempts = 2): Promise<Hex> {
  for (let i = 0; ; i++) {
    const plan = await planFee(ctx, calls);
    try { return await ctx.bundler.sendUserOperation({ account: ctx.account, calls: plan.calls }); }
    catch (e) { const r = paymasterReason(e); if (r && REPLAN_REASONS.has(r) && i < attempts) continue; throw e; }
  }
}

// ParamCondition values of the Universal Action Policy (module-sdk's enum is not exported from its root).
const EQUAL = 0, LESS_THAN_OR_EQUAL = 4;
const emptyRule = { condition: EQUAL, offset: 0n, isLimited: false, ref: pad("0x00", { size: 32 }) as Hex, usage: { limit: 0n, used: 0n } };

/**
 * Session action that lets an agent pay its own gas from the user's account: `token.approve(spender, amount)` where
 * the spender can only be `paymaster`, each amount is at most `perCall`, and the amounts add up to at most `total`
 * over the session. Enforced on-chain by Smart Sessions' Universal Action Policy — the agent can't approve anyone
 * else, so it can't move funds through this action; it can only let the paymaster collect gas.
 *
 * `perCall` must cover one op's approve (≈1.5× its maximum fee — see feeApprovalCall). `total` bounds the gas a
 * misbehaving agent can burn, because fees are outside the session's spending limit. Pair it with a session
 * `usageLimit`.
 */
export function feeApproveAction(p: { token: Address; paymaster: Address; perCall: bigint; total: bigint }): ActionSpec {
  const policy = getUniversalActionPolicy({
    valueLimitPerUse: 0n,
    paramRules: {
      length: 2n,
      rules: [
        { condition: EQUAL, offset: 0n, isLimited: false, ref: pad(p.paymaster, { size: 32 }) as Hex, usage: { limit: 0n, used: 0n } },
        { condition: LESS_THAN_OR_EQUAL, offset: 32n, isLimited: true, ref: pad(toHex(p.perCall), { size: 32 }) as Hex, usage: { limit: p.total, used: 0n } },
        // The policy's rule array is a fixed tuple[16]; `length` marks how many are live.
        ...Array.from({ length: 14 }, () => emptyRule),
      ] as never,
    },
  });
  return { target: p.token, signature: "approve(address,uint256)", policies: [{ address: policy.address, initData: policy.initData }], spendLimit: false };
}
