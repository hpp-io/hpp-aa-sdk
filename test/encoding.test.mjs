// Encodings must match the byte layouts proven on HPP Sepolia by test/cases/*.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, pad, parseAbi } from "viem";
import { getSmartSessionsValidator } from "@rhinestone/module-sdk";
import {
  ADDRESSES, KERNEL_EXECUTE_SELECTOR, EXEC_MODE_BATCH, EXEC_MODE_SINGLE, HOOK_MODULE_INSTALLED,
  encodeKernelExecute, installSmartSessionsCall, kernelAbi, kernelDelegationCode, kernelInitializeData,
  sessionNonceKey, smartSessionsInstallData, buildSession, TOKENS,
} from "../dist/index.js";

const SS = ADDRESSES.smartSessions, USDC = TOKENS[181228].USDCe;

test("session nonce key = [00][01][SmartSessions][0000] left-aligned (t410 formula)", () => {
  const expected = BigInt(pad(concatHex(["0x00", "0x01", SS]), { dir: "right", size: 24 }));
  assert.equal(sessionNonceKey(), expected);
  assert.notEqual(sessionNonceKey(), BigInt(pad(concatHex(["0x00", "0x00", SS]), { dir: "right", size: 24 })), "type 0x00 would route to the 7702 root");
});

test("Smart Sessions initData = hook sentinel ‖ abi.encode(validatorData, hookData, execute selector) (t410)", () => {
  const SSm = getSmartSessionsValidator({});
  const expected = concatHex([HOOK_MODULE_INSTALLED, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [SSm.initData ?? "0x", "0x", "0xe9ae5c53"])]);
  assert.equal(smartSessionsInstallData(), expected);
  assert.equal(KERNEL_EXECUTE_SELECTOR, "0xe9ae5c53");
  const call = installSmartSessionsCall("0x1111111111111111111111111111111111111111");
  const dec = decodeFunctionData({ abi: kernelAbi, data: call.data });
  assert.equal(dec.functionName, "installModule");
  assert.deepEqual([dec.args[0], dec.args[1]], [1n, SS]);
});

test("single call = execute(MODE_SINGLE, target‖value‖data) (t410 exec)", () => {
  const data = "0xa9059cbb" + "00".repeat(64);
  const out = encodeKernelExecute([{ to: USDC, value: 0n, data }]);
  const expected = encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [EXEC_MODE_SINGLE, concatHex([USDC, pad("0x0", { size: 32 }), data])] });
  assert.equal(out, expected);
});

test("batch = execute(MODE_BATCH, abi.encode(Execution[]))", () => {
  const calls = [{ to: USDC, data: "0x01" }, { to: ADDRESSES.multicall3, value: 5n, data: "0x02" }];
  const dec = decodeFunctionData({ abi: kernelAbi, data: encodeKernelExecute(calls) });
  assert.equal(dec.args[0], EXEC_MODE_BATCH);
  assert.equal(EXEC_MODE_BATCH.slice(0, 4), "0x01", "callType byte = 0x01 BATCH");
  const expected = encodeAbiParameters([{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }], [[[USDC, 0n, "0x01"], [ADDRESSES.multicall3, 5n, "0x02"]]]);
  assert.equal(dec.args[1], expected);
});

test("factory initialize: root = 0x01‖ECDSAValidator, validatorData = owner", () => {
  const owner = "0x2222222222222222222222222222222222222222";
  const dec = decodeFunctionData({ abi: kernelAbi, data: kernelInitializeData(owner) });
  assert.equal(dec.functionName, "initialize");
  assert.equal(dec.args[0].toLowerCase(), ("0x01" + ADDRESSES.kernelEcdsaValidator.slice(2)).toLowerCase());
  assert.equal(dec.args[2].toLowerCase(), owner.toLowerCase());
});

test("7702 delegation code", () => {
  assert.equal(kernelDelegationCode(), ("0xef0100" + ADDRESSES.kernelV33.slice(2)).toLowerCase());
});

test("buildSession: spend limit lands on the token action, sudo elsewhere, permissionId deterministic for fixed salt", () => {
  const spec = { signer: "0x3333333333333333333333333333333333333333", salt: "0x" + "ab".repeat(32),
    actions: [{ target: USDC, signature: "transfer(address,uint256)" }, { target: ADDRESSES.multicall3, selector: "0x42cbb15c" }],
    spend: [{ token: USDC, limit: 100_000n }], usageLimit: 2n };
  const a = buildSession(spec, 181228), b = buildSession(spec, 181228);
  assert.equal(a.permissionId, b.permissionId);
  assert.equal(a.session.actions[0].actionTargetSelector, "0xa9059cbb");
  assert.equal(a.session.actions[0].actionPolicies[0].policy.toLowerCase(), "0x000000000033212e272655d8a22402db819477a6"); // SpendingLimits
  assert.equal(a.session.actions[1].actionPolicies[0].policy.toLowerCase(), "0x0000000000feec8d74e3143fbabbca515358d869"); // Sudo
  assert.equal(a.session.userOpPolicies[0].policy.toLowerCase(), "0x00000000001d4479fa2a947026204d0283cede4b"); // UsageLimit
  assert.equal(a.session.sessionValidator.toLowerCase(), ADDRESSES.ownableValidator.toLowerCase());
  assert.equal(a.session.permitERC4337Paymaster, true);
});

test("withLane: viem's Date.now() key must not leak into the validator/type bytes", async () => {
  const { withLane, ROOT_NONCE_KEY } = await import("../dist/index.js");
  const base = sessionNonceKey();
  assert.equal(withLane(base, BigInt(Date.now())), base, "large auto key → lane 0, key untouched");
  assert.equal(withLane(base, undefined), base);
  assert.equal(withLane(base, 3n), base | 3n);
  assert.equal(withLane(ROOT_NONCE_KEY, 65536n), 0n, "out-of-range lane ignored");
  // type byte (index 1 of 24) still 0x01 after a lane is applied
  const hex = (withLane(base, 7n)).toString(16).padStart(48, "0");
  assert.equal(hex.slice(2, 4), "01");
});
