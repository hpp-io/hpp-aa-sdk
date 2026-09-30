import { test } from "node:test";
import assert from "node:assert/strict";
import { concatHex, createPublicClient, decodeFunctionData, encodeAbiParameters, hashTypedData, http, keccak256, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANY_DELEGATE, ROOT_AUTHORITY, DELEGATION_TYPES, caveatTerms, buildPaymentDelegation, buildPaymentRedelegation,
  decodeDelegations, delegationDigest, delegationHash, delegationManagerAbi, delegationTypedData, encodeDelegations,
  erc7710Environment, installDelegationExecutorCall, revokeDelegationCall, signPaymentRedelegation,
} from "../dist/erc7710.js";
import { ERC7710, ADDRESSES } from "../dist/addresses.js";
import { kernelAbi } from "../dist/kernel.js";
import { hppSepolia } from "../dist/chains.js";

const CHAIN_ID = 181228;
const { delegationManager: DM, enforcers } = ERC7710[CHAIN_ID];
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const USER = "0x33019d8BE92937016371E22C710ABB71fACde773";
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const F = "0x050BC3f099f0489D89b94C46Fa7DcEDf8aD7C7E0";
const PAY_TO = "0x9Dc2A176Ca65D982854CDe9BE84Dc7028236ba2c";

test("executor install call: module type 2, DM address, hook 0x…01, EMPTY executorData (Kernel skips onInstall)", () => {
  const call = installDelegationExecutorCall(USER, DM);
  assert.equal(call.to, USER);
  const { functionName, args } = decodeFunctionData({ abi: kernelAbi, data: call.data });
  assert.equal(functionName, "installModule");
  assert.equal(args[0], 2n);
  assert.equal(args[1], DM);
  const initData = args[2];
  assert.equal(initData.slice(0, 42), "0x0000000000000000000000000000000000000001");
  assert.equal("0x" + initData.slice(42), encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], ["0x", "0x"]));
});

test("caveat terms have the byte lengths the v1.3.0 enforcers require", () => {
  const len = (h) => (h.length - 2) / 2;
  assert.equal(len(caveatTerms.erc20TransferAmount(USDC, 1n)), 52);
  assert.equal(len(caveatTerms.erc20PeriodTransfer(USDC, 1n, 2n, 3n)), 116);
  assert.equal(len(caveatTerms.timestamp(0n, 1n)), 32);
  assert.equal(len(caveatTerms.redeemers([F, USER])), 40); // packed, not abi-encoded
  assert.equal(len(caveatTerms.transferTo(PAY_TO)), 64);
  assert.equal(len(caveatTerms.limitedCalls(3n)), 32);
  assert.equal(caveatTerms.transferTo(PAY_TO).slice(2, 66), "0".repeat(63) + "4"); // start offset 4 = after the selector
});

test("buildPaymentDelegation: root authority, delegate = agent, caveats follow the spec", () => {
  const d = buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: parseUnits("5", 6), validUntil: 1_800_000_000n, maxCalls: 10n, salt: 7n });
  assert.equal(d.authority, ROOT_AUTHORITY);
  assert.equal(d.delegate, agent.address);
  assert.equal(d.delegator, USER);
  assert.deepEqual(d.caveats.map((c) => c.enforcer), [enforcers.ERC20TransferAmountEnforcer, enforcers.TimestampEnforcer, enforcers.LimitedCallsEnforcer]);
  const p = buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, period: { amount: 1n, seconds: 86400n, start: 1n }, validUntil: 0n });
  assert.deepEqual(p.caveats.map((c) => c.enforcer), [enforcers.ERC20PeriodTransferEnforcer]);
  assert.throws(() => buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, validUntil: 1n }), /limit.*period/);
  assert.throws(() => buildPaymentDelegation(1, USER, { agent: agent.address, token: USDC, limit: 1n, validUntil: 1n }), /not deployed on chain 1/);
});

test("delegationHash equals the DelegationManager's EncoderLib hashing (typehash + caveat array hash)", () => {
  const d = buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 42n });
  const DELEGATION_TYPEHASH = keccak256(toHex("Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)"));
  const CAVEAT_TYPEHASH = keccak256(toHex("Caveat(address enforcer,bytes terms)"));
  const caveatHashes = d.caveats.map((c) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)])));
  const manual = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, keccak256(concatHex(caveatHashes)), d.salt],
  ));
  assert.equal(delegationHash(d), manual);
  // the digest is the domain-bound EIP-712 hash of the same struct
  assert.equal(delegationDigest(CHAIN_ID, DM, d), hashTypedData(delegationTypedData(CHAIN_ID, DM, d)));
  assert.notEqual(delegationDigest(CHAIN_ID, DM, d), delegationHash(d));
});

test("encode/decode permissionContext round-trips, leaf first", () => {
  const root = { ...buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 1n }), signature: "0x00" + "ab".repeat(65) };
  const leaf = { ...buildPaymentRedelegation(CHAIN_ID, agent.address, { parentPermissionContext: encodeDelegations([root]), facilitatorAddresses: [F], token: USDC, amount: 1n, payTo: PAY_TO, validUntil: 9n, salt: 2n }), signature: "0x" + "cd".repeat(65) };
  const ctx = encodeDelegations([leaf, root]);
  const back = decodeDelegations(ctx);
  assert.equal(back.length, 2);
  assert.equal(back[0].delegate, ANY_DELEGATE);
  assert.equal(back[0].authority, delegationHash(root));
  assert.equal(back[1].authority, ROOT_AUTHORITY);
  assert.deepEqual(back[1].caveats, root.caveats);
  assert.equal(back[0].signature, leaf.signature);
});

test("buildPaymentRedelegation: ANY_DELEGATE scoped by redeemer/amount/payTo/expiry, in that order; parent must be for this agent", () => {
  const root = { ...buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 1n }), signature: "0x00" + "ab".repeat(65) };
  const leaf = buildPaymentRedelegation(CHAIN_ID, agent.address, { parentPermissionContext: encodeDelegations([root]), facilitatorAddresses: [F], token: USDC, amount: 10000n, payTo: PAY_TO, validUntil: 123n });
  assert.equal(leaf.delegate, ANY_DELEGATE);
  assert.equal(leaf.delegator, agent.address);
  assert.deepEqual(leaf.caveats.map((c) => c.enforcer), [enforcers.RedeemerEnforcer, enforcers.ERC20TransferAmountEnforcer, enforcers.AllowedCalldataEnforcer, enforcers.TimestampEnforcer]);
  assert.equal(leaf.caveats[0].terms.toLowerCase(), F.toLowerCase());
  assert.equal(leaf.caveats[1].terms, caveatTerms.erc20TransferAmount(USDC, 10000n));
  assert.equal(leaf.caveats[3].terms, caveatTerms.timestamp(0n, 123n));
  assert.throws(() => buildPaymentRedelegation(CHAIN_ID, USER, { parentPermissionContext: encodeDelegations([root]), facilitatorAddresses: [F], token: USDC, amount: 1n, payTo: PAY_TO }), /not this agent/);
  assert.throws(() => buildPaymentRedelegation(CHAIN_ID, agent.address, { parentPermissionContext: encodeDelegations([root]), facilitatorAddresses: [], token: USDC, amount: 1n, payTo: PAY_TO }), /facilitatorAddresses is empty/);
});

test("signPaymentRedelegation: agent EOA signs the DM-domain digest; payload names the root delegator", async () => {
  const root = { ...buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 1n }), signature: "0x00" + "ab".repeat(65) };
  const parentCtx = encodeDelegations([root]);
  const leaf = buildPaymentRedelegation(CHAIN_ID, agent.address, { parentPermissionContext: parentCtx, facilitatorAddresses: [F], token: USDC, amount: 1n, payTo: PAY_TO, validUntil: 9n, salt: 3n });
  const payload = await signPaymentRedelegation({ chainId: CHAIN_ID, agent, leaf, parentPermissionContext: parentCtx });
  assert.equal(payload.delegationManager, DM);
  assert.equal(payload.delegator, USER);
  const [signedLeaf, back] = decodeDelegations(payload.permissionContext);
  assert.equal(back.signature, root.signature);
  const expected = await agent.signTypedData(delegationTypedData(CHAIN_ID, DM, leaf));
  assert.equal(signedLeaf.signature, expected);
});

test("revoke call targets DM.disableDelegation with the full struct; environment matches the kit shape", () => {
  const d = buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 1n });
  const call = revokeDelegationCall(DM, d);
  assert.equal(call.to, DM);
  const { functionName } = decodeFunctionData({ abi: delegationManagerAbi, data: call.data });
  assert.equal(functionName, "disableDelegation");
  const env = erc7710Environment(CHAIN_ID);
  assert.equal(env.DelegationManager, DM);
  assert.equal(env.EntryPoint, ADDRESSES.entryPoint07);
  assert.equal(env.caveatEnforcers.RedeemerEnforcer, enforcers.RedeemerEnforcer);
  assert.deepEqual(Object.keys(DELEGATION_TYPES), ["Delegation", "Caveat"]);
});

// Live cross-check (needs network): our hash == DelegationManager.getDelegationHash.
test("delegationHash matches DelegationManager.getDelegationHash on HPP Sepolia", { skip: !process.env.LIVE }, async () => {
  const client = createPublicClient({ chain: hppSepolia, transport: http(process.env.RPC ?? "https://sepolia-node1.hpp.io") });
  const d = buildPaymentDelegation(CHAIN_ID, USER, { agent: agent.address, token: USDC, limit: 5n, validUntil: 9n, salt: 99n });
  const onchain = await client.readContract({ address: DM, abi: delegationManagerAbi, functionName: "getDelegationHash", args: [d] });
  assert.equal(delegationHash(d), onchain);
});
