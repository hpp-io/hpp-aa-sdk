import { test } from "node:test";
import assert from "node:assert/strict";
import { createHppPaymaster, HppPaymasterError, paymasterReason, REQUOTE_REASONS, feeInfoOf, chargedTokenFromReceipt } from "../dist/index.js";

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032", PM_V = "0x686f803a2c8c7f7e88e5e6abfedc1dbea1e2b5bc", PM_T = "0xb4c0E1b0498A35330fd1DE0C85977A6721638db4";
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D", SENDER = "0x33019d8BE92937016371E22C710ABB71fACde773";
const op = { sender: SENDER, nonce: 5n, callData: "0x", maxFeePerGas: 19_050_000n, maxPriorityFeePerGas: 0n, signature: "0x", chainId: 181228, entryPointAddress: EP };

// fetch 목: 요청을 기록하고 정해진 응답을 돌려준다
function mockFetch(responses) {
  const calls = [];
  const f = async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); const r = responses[body.method] ?? {}; return { json: async () => ({ jsonrpc: "2.0", id: 1, ...(typeof r === "function" ? r(body) : r) }) }; };
  return { f, calls };
}

test("stub keeps the hpp quote; getPaymasterData sends quotedRate back and merges the HPP context", async () => {
  const tokenHpp = { mode: "token", token: USDC, symbol: "USDC.e", decimals: 6, exchangeRate: "4200000000", maxToken: null, treasury: "0x" + "ba".repeat(20), erc20Paymaster: PM_T };
  const { f, calls } = mockFetch({
    pm_getPaymasterStubData: { result: { paymaster: PM_T, paymasterData: "0x03", paymasterVerificationGasLimit: "0x186a0", paymasterPostOpGasLimit: "0x1d4c0", isFinal: false, hpp: tokenHpp } },
    pm_getPaymasterData: { result: { paymaster: PM_T, paymasterData: "0x03ff", hpp: { ...tokenHpp, maxToken: "227683" } } },
  });
  const pm = createHppPaymaster({ url: "http://pm.test/rpc", context: { policyId: "p", anchorId: "a" }, fetch: f });
  const stub = await pm.getPaymasterStubData(op);
  assert.equal(stub.paymaster, PM_T); assert.equal(stub.paymasterVerificationGasLimit, 100000n); assert.equal(stub.paymasterPostOpGasLimit, 120000n);
  assert.deepEqual(calls[0].params[3], { policyId: "p", anchorId: "a" });
  assert.equal(calls[0].params[0].nonce, "0x5", "op fields are hex-formatted for JSON-RPC");
  const q1 = pm.lastQuote(SENDER); assert.equal(q1.mode, "token"); assert.equal(q1.exchangeRate, 4200000000n);
  const data = await pm.getPaymasterData(op);
  assert.equal(data.paymasterData, "0x03ff");
  assert.deepEqual(calls[1].params[3], { policyId: "p", anchorId: "a", quotedRate: "4200000000" });
  assert.equal(pm.lastQuote(SENDER).maxToken, 227683n);
});

test("sponsored stub: no quotedRate, erc20Paymaster/feeToken passthrough for early approve", async () => {
  const { f, calls } = mockFetch({
    pm_getPaymasterStubData: { result: { paymaster: PM_V, paymasterData: "0x00", paymasterVerificationGasLimit: "0xea60", paymasterPostOpGasLimit: "0x0", hpp: { mode: "sponsored", freeRemaining: 2, erc20Paymaster: PM_T, feeToken: { token: USDC, symbol: "USDC.e", decimals: 6 } } } },
    pm_getPaymasterData: { result: { paymaster: PM_V, paymasterData: "0x00aa", hpp: { mode: "sponsored", freeRemaining: 1 } } },
  });
  const pm = createHppPaymaster({ url: "u", context: { policyId: "p" }, fetch: f });
  await pm.getPaymasterStubData(op);
  const q = pm.lastQuote(SENDER); assert.equal(q.mode, "sponsored"); assert.equal(q.freeRemaining, 2); assert.equal(q.erc20Paymaster, PM_T); assert.equal(q.feeToken.symbol, "USDC.e");
  await pm.getPaymasterData(op);
  assert.deepEqual(calls[1].params[3], { policyId: "p" });
});

test("-32000 rejections become HppPaymasterError with the reason; re-quote reasons are recognised through viem-style cause chains", async () => {
  const { f } = mockFetch({ pm_getPaymasterData: { error: { code: -32000, message: "sponsorship denied: free ops used up", data: { reason: "free_exhausted" } } } });
  const pm = createHppPaymaster({ url: "u", context: { policyId: "p" }, fetch: f });
  await assert.rejects(pm.getPaymasterData(op), (e) => e instanceof HppPaymasterError && e.reason === "free_exhausted" && e.code === -32000);
  const wrapped = { name: "UserOperationExecutionError", cause: { name: "RpcRequestError", cause: { code: -32000, data: { reason: "fee_quote_stale" } } } };
  assert.equal(paymasterReason(wrapped), "fee_quote_stale");
  assert.equal(paymasterReason(new Error("x")), null);
  assert.ok(REQUOTE_REASONS.has("free_exhausted") && REQUOTE_REASONS.has("fee_quote_stale") && !REQUOTE_REASONS.has("fee_balance_insufficient"));
});

test("feeInfoOf: token charge is read from the UserOperationSponsored log of the ERC-20 paymaster", async () => {
  const { f } = mockFetch({ pm_getPaymasterStubData: { result: { paymaster: PM_T, paymasterData: "0x", paymasterVerificationGasLimit: "0x1", paymasterPostOpGasLimit: "0x1", hpp: { mode: "token", token: USDC, symbol: "USDC.e", decimals: 6, exchangeRate: "4200000000", maxToken: "227683", treasury: "0x" + "ba".repeat(20) } } } });
  const pm = createHppPaymaster({ url: "u", context: { policyId: "p" }, fetch: f });
  await pm.getPaymasterStubData(op);
  const hash = "0x" + "11".repeat(32);
  // topics: sig, userOpHash, user ; data: mode(1) token amount rate
  const data = "0x" + "00".repeat(31) + "01" + "00".repeat(12) + USDC.slice(2).toLowerCase() + (113440n).toString(16).padStart(64, "0") + (4200000000n).toString(16).padStart(64, "0");
  const receipt = { logs: [{ address: PM_T, topics: ["0x" + "ee".repeat(32), hash, "0x" + "00".repeat(12) + SENDER.slice(2).toLowerCase()], data }] };
  // topic0 must be the real event signature for decodeEventLog — compute it from the ABI via a throwaway decode of the right selector
  const { keccak256, toHex } = await import("viem");
  receipt.logs[0].topics[0] = keccak256(toHex("UserOperationSponsored(bytes32,address,uint8,address,uint256,uint256)"));
  assert.equal(chargedTokenFromReceipt(receipt, PM_T, hash), 113440n);
  const fee = feeInfoOf(pm, SENDER, receipt, hash);
  assert.equal(fee.mode, "token"); assert.equal(fee.charged, 113440n); assert.equal(fee.maxToken, 227683n);
  assert.deepEqual(feeInfoOf(undefined, SENDER, receipt, hash), { mode: "self" });
});
