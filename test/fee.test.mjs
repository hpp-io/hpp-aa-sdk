import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";
import { feeApprovalCall, approveCall, planFee, sendWithFee, feeApproveAction, buildSession, HppPaymasterError } from "../dist/index.js";

const PM_V = "0x686f803a2c8c7f7e88e5e6abfedc1dbea1e2b5bc", PM_T = "0xb4c0E1b0498A35330fd1DE0C85977A6721638db4";
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D", SENDER = "0x33019d8BE92937016371E22C710ABB71fACde773";
const OTHER = "0x00000000000000000000000000000000000000aa";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const approved = (c) => { const d = decodeFunctionData({ abi: erc20, data: c.data }); return { spender: d.args[0], amount: d.args[1] }; };

// 1e18 wei of gas = 4200 USDC.e (6 decimals) → rate 4.2e9 base units per 1e18 wei
const RATE = 4_200_000_000n;
const base = { token: USDC, spender: PM_T, decimals: 6, exchangeRate: RATE };

test("feeApprovalCall: approves 1.5× the op's max token cost", () => {
  const c = feeApprovalCall({ ...base, maxCostWei: 50_000_000_000_000n, allowance: 0n }); // 5e13 wei → 210000 (0.21 USDC.e)
  assert.equal(c.to, USDC);
  assert.deepEqual(approved(c), { spender: PM_T, amount: 315_000n });
});

test("feeApprovalCall: skips when the allowance already covers 1.25×; re-approves below that", () => {
  assert.equal(feeApprovalCall({ ...base, maxCostWei: 50_000_000_000_000n, allowance: 262_500n }), null);
  assert.ok(feeApprovalCall({ ...base, maxCostWei: 50_000_000_000_000n, allowance: 262_499n }));
});

test("feeApprovalCall: never approves below the minimum fee (10^(decimals-3))", () => {
  const c = feeApprovalCall({ ...base, maxCostWei: 1n, allowance: 0n });
  assert.equal(approved(c).amount, 1500n); // floor 1000 × 1.5
});

// ── planFee / sendWithFee with a fake bundler, account, chain client and paymaster ──

const uint = (v) => encodeAbiParameters([{ type: "uint256" }], [v]);
function ctxFor({ quotes, allowance = 0n, est, sendErrors = [] }) {
  const log = { stubs: 0, estimates: [], sent: [] };
  let q = 0;
  const paymaster = {
    async getPaymasterStubData() { log.stubs++; return { paymaster: PM_T, paymasterData: "0x", paymasterVerificationGasLimit: 30_000n, paymasterPostOpGasLimit: 50_000n }; },
    lastQuote() { return quotes[Math.min(q++, quotes.length - 1)]; },
  };
  const bundler = {
    async request({ method }) { assert.equal(method, "rundler_getUserOperationGasPrice"); return { suggested: { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x0" } }; }, // 1 gwei
    async estimateUserOperationGas(a) { log.estimates.push(a.calls); return est ?? { verificationGasLimit: 100_000n, callGasLimit: 100_000n, preVerificationGas: 200_000n }; },
    async sendUserOperation(a) { log.sent.push(a.calls); const e = sendErrors.shift(); if (e) throw e; return "0x" + "ab".repeat(32); },
  };
  const account = { async getNonce() { return 0n; }, async encodeCalls() { return "0x1234"; }, async getStubSignature() { return "0x"; }, entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" } };
  const client = { chain: { id: 181228 }, async request({ method }) { assert.equal(method, "eth_call"); return uint(allowance); } };
  return { ctx: { bundler, account, client, paymaster, chain: { id: 181228 }, sender: SENDER }, log };
}
const tokenQuote = { mode: "token", token: USDC, symbol: "USDC.e", decimals: 6, exchangeRate: RATE, maxToken: null, treasury: OTHER, erc20Paymaster: PM_T, paymaster: PM_T };
const call = { to: OTHER, value: 0n, data: "0xdeadbeef" };

test("planFee: token mode prepends the approve, priced with a placeholder approve in place", async () => {
  const { ctx, log } = ctxFor({ quotes: [tokenQuote] });
  const plan = await planFee(ctx, [call]);
  // gas 400k + pm 80k = 480k × 1 gwei = 4.8e14 wei → 2016000 base units; approve 1.5× = 3024000
  assert.equal(plan.maxToken, 2_016_000n);
  assert.equal(plan.calls.length, 2);
  assert.deepEqual(approved(plan.calls[0]), { spender: PM_T, amount: 3_024_000n });
  assert.equal(plan.calls[1], call);
  assert.equal(log.estimates[0].length, 2, "estimate includes the approve");
  assert.equal(approved(log.estimates[0][0]).amount, 100_000n, "placeholder = 0.1 token, inside any session per-call cap");
});

test("planFee: enough allowance → calls unchanged", async () => {
  const { ctx } = ctxFor({ quotes: [tokenQuote], allowance: 10_000_000n });
  const plan = await planFee(ctx, [call]);
  assert.deepEqual(plan.calls, [call]);
  assert.equal(plan.maxToken, 2_016_000n);
});

test("planFee: sponsored op → no approve, no estimate; a policy that never charges is remembered", async () => {
  const free = ctxFor({ quotes: [{ mode: "sponsored", freeRemaining: 2, erc20Paymaster: PM_T, feeToken: { token: USDC, symbol: "USDC.e", decimals: 6 } }] });
  assert.deepEqual((await planFee(free.ctx, [call])).calls, [call]);
  assert.equal(free.log.estimates.length, 0);

  const never = ctxFor({ quotes: [{ mode: "sponsored", freeRemaining: null, feeToken: null }] });
  await planFee(never.ctx, [call]);
  await planFee(never.ctx, [call]);
  assert.equal(never.log.stubs, 1, "second plan skips the stub round trip");
});

test("sendWithFee: free_exhausted → re-plans and sends with the approve the new token quote needs", async () => {
  const exhausted = new HppPaymasterError("free_exhausted", "free ops used up");
  const { ctx, log } = ctxFor({ quotes: [{ mode: "sponsored", freeRemaining: 1, erc20Paymaster: PM_T, feeToken: { token: USDC, symbol: "USDC.e", decimals: 6 } }, tokenQuote], sendErrors: [exhausted] });
  await sendWithFee(ctx, [call]);
  assert.equal(log.sent.length, 2);
  assert.equal(log.sent[0].length, 1);
  assert.equal(log.sent[1].length, 2, "second attempt carries the approve");
});

test("sendWithFee: fee_allowance_missing retries; other denials surface", async () => {
  const missing = new HppPaymasterError("fee_allowance_missing", "allowance");
  const ok = ctxFor({ quotes: [tokenQuote], sendErrors: [missing] });
  await sendWithFee(ok.ctx, [call]);
  assert.equal(ok.log.sent.length, 2);

  const broke = new HppPaymasterError("fee_balance_insufficient", "balance");
  const bad = ctxFor({ quotes: [tokenQuote], sendErrors: [broke] });
  await assert.rejects(sendWithFee(bad.ctx, [call]), (e) => e === broke);
  assert.equal(bad.log.sent.length, 1);
});

// ── session: paymaster-only approve ──

test("feeApproveAction: spender pinned to the paymaster, per-call ≤ cap with a cumulative limit, no spending-limit policy", () => {
  const a = feeApproveAction({ token: USDC, paymaster: PM_T, perCall: 300_000n, total: 5_000_000n });
  assert.equal(a.target, USDC); assert.equal(a.signature, "approve(address,uint256)"); assert.equal(a.spendLimit, false);
  assert.equal(a.policies.length, 1);
  const [cfg] = decodeAbiParameters([{ type: "tuple", components: [
    { type: "uint256", name: "valueLimitPerUse" },
    { type: "tuple", name: "paramRules", components: [{ type: "uint256", name: "length" }, { type: "tuple[16]", name: "rules", components: [
      { type: "uint8", name: "condition" }, { type: "uint64", name: "offset" }, { type: "bool", name: "isLimited" }, { type: "bytes32", name: "ref" },
      { type: "tuple", name: "usage", components: [{ type: "uint256", name: "limit" }, { type: "uint256", name: "used" }] }] }] }] }], a.policies[0].initData);
  assert.equal(cfg.paramRules.length, 2n);
  const [r0, r1] = cfg.paramRules.rules;
  assert.equal(r0.condition, 0); assert.equal(r0.offset, 0n); assert.equal(BigInt(r0.ref), BigInt(PM_T));
  assert.equal(r1.condition, 4); assert.equal(r1.offset, 32n); assert.equal(BigInt(r1.ref), 300_000n);
  assert.equal(r1.isLimited, true); assert.equal(r1.usage.limit, 5_000_000n);

  const signer = "0x00000000000000000000000000000000000000bb";
  const { session } = buildSession({ signer, actions: [{ target: USDC, signature: "transfer(address,uint256)" }, a], spend: [{ token: USDC, limit: 1_000_000n }] }, 181228);
  assert.equal(session.actions[0].actionPolicies.length, 1, "transfer gets the spending limit");
  assert.equal(session.actions[1].actionPolicies.length, 1, "fee approve keeps only its own policy");
  assert.equal(session.actions[1].actionPolicies[0].policy, a.policies[0].address);
});

test("approveCall encodes token.approve(spender, amount)", () => {
  assert.deepEqual(approved(approveCall(USDC, PM_T, 7n)), { spender: PM_T, amount: 7n });
});

test("session policy ConfigIds match live Smart Sessions state (HPP Sepolia, 2026-10-13 probe)", async () => {
  const { userOpPolicyConfigId, actionPolicyConfigId } = await import("../dist/index.js");
  const { keccak256, encodePacked, toFunctionSelector } = await import("viem");
  const acct = "0x00000000000000000000000000000000000000cc", pid = "0x" + "11".repeat(32);
  assert.equal(userOpPolicyConfigId(acct, pid), keccak256(encodePacked(["address", "bytes32"], [acct, pid])));
  const sel = toFunctionSelector("approve(address,uint256)");
  const aid = keccak256(encodePacked(["address", "bytes4"], [USDC, sel]));
  assert.equal(actionPolicyConfigId(acct, pid, USDC, sel), keccak256(encodePacked(["address", "bytes32"], [acct, keccak256(encodePacked(["bytes32", "bytes32"], [pid, aid]))])));
});
