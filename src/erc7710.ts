/**
 * ERC-7710 payment delegations — "an agent pays x402 from the user's account,
 * without holding funds, under on-chain caps".
 *
 * Wallet side (this file + `HppAccount.grantPaymentDelegation`):
 *   1. install HPP's DelegationManager as an ERC-7579 executor on the Kernel account (one UserOp, once)
 *   2. sign a delegation to the agent key: ERC20TransferAmount (total cap) or ERC20PeriodTransfer
 *      (cap per period) + Timestamp (expiry). Off-chain EIP-712, ERC-1271 wrapped — no UserOp.
 *   3. hand the agent `permissionContext` (the encoded, signed delegation).
 * Agent side: per payment, redelegate to ANY_DELEGATE scoped by RedeemerEnforcer(facilitator keys)
 *   + ERC20TransferAmount(amount) + AllowedCalldata(to = payTo) + Timestamp, and send
 *   `{ delegationManager, permissionContext, delegator }` as the x402 `exact`/`erc7710` payload
 *   (`buildPaymentRedelegation` here, or `@metamask/x402`'s delegation provider with
 *   `erc7710Environment()` — same bytes).
 * Revoke: `DM.disableDelegation(delegation)` from the account (one UserOp), effective immediately.
 *
 * Contracts: MetaMask delegation-framework v1.3.0, unmodified (see `ERC7710` in addresses.ts).
 */
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hashStruct,
  hashTypedData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { readContract } from "viem/actions";
import { ADDRESSES, ERC7710 } from "./addresses.js";
import { HOOK_MODULE_INSTALLED, kernelAbi, type Call } from "./kernel.js";
import { signErc1271TypedData } from "./erc1271.js";
import type { Owner } from "./owner.js";
import type { ChainClient } from "./types.js";

export const ANY_DELEGATE: Address = "0x0000000000000000000000000000000000000a11";
export const ROOT_AUTHORITY: Hex = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

export const delegationManagerAbi = parseAbi([
  "struct Caveat { address enforcer; bytes terms; bytes args; }",
  "struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }",
  "function disableDelegation(Delegation d)",
  "function enableDelegation(Delegation d)",
  "function getDelegationHash(Delegation d) pure returns (bytes32)",
  "function disabledDelegations(bytes32) view returns (bool)",
]);

export type Caveat = { enforcer: Address; terms: Hex; args: Hex };
export type Delegation = { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: bigint; signature: Hex };

export const DELEGATION_TYPES = {
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
  ],
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
  ],
} as const;

const DELEGATION_ARRAY_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export function erc7710Config(chainId: number) {
  const cfg = ERC7710[chainId];
  if (!cfg) throw new Error(`ERC-7710 delegation contracts are not deployed on chain ${chainId}`);
  return cfg;
}

/**
 * `SmartAccountsEnvironment` for `@metamask/smart-accounts-kit`:
 * `overrideDeployedEnvironment(chainId, "1.3.0", erc7710Environment(chainId))`.
 * Only what the x402 delegation provider touches is filled; HPP accounts are Kernel, not DeleGators.
 */
export function erc7710Environment(chainId: number) {
  const { delegationManager, enforcers } = erc7710Config(chainId);
  return {
    DelegationManager: delegationManager,
    EntryPoint: ADDRESSES.entryPoint07,
    SimpleFactory: "0x0000000000000000000000000000000000000000" as Address,
    implementations: {} as Record<string, Address>,
    caveatEnforcers: { ...enforcers } as Record<string, Address>,
  };
}

// ---- account: executor install / revoke calls ------------------------------------------------

/**
 * Self-call installing the DelegationManager as executor (module type 2). Empty `executorData`
 * matters: Kernel v3.3 then ignores the (absent) `onInstall` — the DelegationManager is not an
 * ERC-7579 module. Hook = 0x…01 (none).
 */
export function installDelegationExecutorCall(account: Address, delegationManager: Address): Call {
  const initData = concatHex([HOOK_MODULE_INSTALLED, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], ["0x", "0x"])]);
  return { to: account, data: encodeFunctionData({ abi: kernelAbi, functionName: "installModule", args: [2n, delegationManager, initData] }) };
}

export async function isDelegationExecutorInstalled(client: ChainClient, account: Address, delegationManager: Address): Promise<boolean> {
  try {
    return (await readContract(client, { address: account, abi: kernelAbi, functionName: "isModuleInstalled", args: [2n, delegationManager, "0x"] })) as boolean;
  } catch {
    return false; // not delegated / not deployed yet
  }
}

/** Call (from the account) that disables a delegation it signed. Effective immediately. */
export function revokeDelegationCall(delegationManager: Address, delegation: Delegation): Call {
  return { to: delegationManager, data: encodeFunctionData({ abi: delegationManagerAbi, functionName: "disableDelegation", args: [delegation] }) };
}

export async function isDelegationDisabled(client: ChainClient, delegationManager: Address, delegation: Delegation): Promise<boolean> {
  return (await readContract(client, { address: delegationManager, abi: delegationManagerAbi, functionName: "disabledDelegations", args: [delegationHash(delegation)] })) as boolean;
}

// ---- hashing / encoding ------------------------------------------------------------------------

/** EIP-712 struct hash = what the DelegationManager calls the delegation hash (`authority` of a child, `disabledDelegations` key). */
export function delegationHash(d: Delegation): Hex {
  return hashStruct({ data: typedMessage(d), primaryType: "Delegation", types: DELEGATION_TYPES });
}

export function delegationTypedData(chainId: number, delegationManager: Address, d: Delegation) {
  return {
    domain: { name: "DelegationManager", version: "1", chainId, verifyingContract: delegationManager },
    types: DELEGATION_TYPES,
    primaryType: "Delegation" as const,
    message: typedMessage(d),
  };
}

/** Digest the delegator signs (domain-bound; for contracts the DM checks it through ERC-1271). */
export function delegationDigest(chainId: number, delegationManager: Address, d: Delegation): Hex {
  return hashTypedData(delegationTypedData(chainId, delegationManager, d));
}

function typedMessage(d: Delegation) {
  return { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: d.salt };
}

/** `permissionContext` bytes: leaf first, root last (what `redeemDelegations` decodes). */
export function encodeDelegations(chain: Delegation[]): Hex {
  return encodeAbiParameters(DELEGATION_ARRAY_ABI, [chain as never]);
}

export function decodeDelegations(permissionContext: Hex): Delegation[] {
  const [arr] = decodeAbiParameters(DELEGATION_ARRAY_ABI, permissionContext);
  return (arr as readonly Delegation[]).map((d) => ({ ...d, caveats: [...d.caveats] }));
}

export function randomSalt(): bigint {
  return BigInt(keccak256(toHex(`hpp-7710-${Date.now()}-${Math.random()}`)));
}

// ---- caveat terms (byte layouts of delegation-framework v1.3.0 enforcers) ------------------------

export const caveatTerms = {
  /** ERC20TransferAmountEnforcer: token(20) ‖ maxTokens(32) — cumulative cap over the delegation's lifetime. */
  erc20TransferAmount: (token: Address, max: bigint): Hex => encodePacked(["address", "uint256"], [token, max]),
  /** ERC20PeriodTransferEnforcer: token(20) ‖ periodAmount(32) ‖ periodDuration(32, seconds) ‖ startDate(32, unix). */
  erc20PeriodTransfer: (token: Address, periodAmount: bigint, periodSeconds: bigint, startDate: bigint): Hex =>
    encodePacked(["address", "uint256", "uint256", "uint256"], [token, periodAmount, periodSeconds, startDate]),
  /** TimestampEnforcer: afterThreshold(16) ‖ beforeThreshold(16). 0 = unbounded. */
  timestamp: (afterUnix: bigint, beforeUnix: bigint): Hex => encodePacked(["uint128", "uint128"], [afterUnix, beforeUnix]),
  /** RedeemerEnforcer: 20-byte addresses concatenated (NOT abi-encoded — `address[]` would be 32-byte padded and rejected). */
  redeemers: (redeemers: readonly Address[]): Hex => concatHex(redeemers),
  /** AllowedCalldataEnforcer: start(32) ‖ expected bytes. For `transfer(to, amount)` the `to` word starts at offset 4. */
  transferTo: (payTo: Address): Hex => concatHex([pad(toHex(4n), { size: 32 }), pad(payTo, { size: 32 })]),
  /** LimitedCallsEnforcer: limit(32). */
  limitedCalls: (limit: bigint): Hex => pad(toHex(limit), { size: 32 }),
} as const;

// ---- wallet side: grant -----------------------------------------------------------------------

export type PaymentDelegationSpec = {
  /** Agent key that will redelegate per payment. Never receives funds. */
  agent: Address;
  token: Address;
  /** Cumulative cap (ERC20TransferAmount). Use `period` instead for a rolling cap. */
  limit?: bigint;
  /** Rolling cap: `amount` per `seconds`, starting at `start` (default now). */
  period?: { amount: bigint; seconds: bigint; start?: bigint };
  /** Unix seconds; 0 = no expiry (not recommended). */
  validUntil: bigint;
  /** Max redemptions (LimitedCallsEnforcer). Optional. */
  maxCalls?: bigint;
  salt?: bigint;
};

export function buildPaymentDelegation(chainId: number, delegator: Address, spec: PaymentDelegationSpec): Delegation {
  const { enforcers } = erc7710Config(chainId);
  if (!spec.limit && !spec.period) throw new Error("PaymentDelegationSpec needs `limit` or `period`");
  const caveats: Caveat[] = [];
  if (spec.limit) caveats.push({ enforcer: enforcers.ERC20TransferAmountEnforcer, terms: caveatTerms.erc20TransferAmount(spec.token, spec.limit), args: "0x" });
  if (spec.period) {
    const start = spec.period.start ?? BigInt(Math.floor(Date.now() / 1000));
    caveats.push({ enforcer: enforcers.ERC20PeriodTransferEnforcer, terms: caveatTerms.erc20PeriodTransfer(spec.token, spec.period.amount, spec.period.seconds, start), args: "0x" });
  }
  if (spec.validUntil > 0n) caveats.push({ enforcer: enforcers.TimestampEnforcer, terms: caveatTerms.timestamp(0n, spec.validUntil), args: "0x" });
  if (spec.maxCalls) caveats.push({ enforcer: enforcers.LimitedCallsEnforcer, terms: caveatTerms.limitedCalls(spec.maxCalls), args: "0x" });
  return { delegate: spec.agent, delegator, authority: ROOT_AUTHORITY, caveats, salt: spec.salt ?? randomSalt(), signature: "0x" };
}

/** Sign as the smart account (ERC-1271, Kernel-wrapped) — the DelegationManager calls `isValidSignature` on the delegator. */
export async function signDelegationAsAccount(opts: { client: ChainClient; chainId: number; account: Address; owner: Owner; delegation: Delegation }): Promise<Delegation> {
  const { delegationManager } = erc7710Config(opts.chainId);
  const signature = await signErc1271TypedData({ client: opts.client, account: opts.account, owner: opts.owner, typedData: delegationTypedData(opts.chainId, delegationManager, opts.delegation) });
  return { ...opts.delegation, signature };
}

/** What the wallet hands to the agent: the signed root delegation, encoded (= `parentPermissionContext`). */
export type PaymentGrant = { delegation: Delegation; delegationHash: Hex; permissionContext: Hex; delegationManager: Address; chainId: number };

// ---- agent side: per-payment redelegation -----------------------------------------------------

export type PaymentRedelegationSpec = {
  /** The grant's encoded root delegation (or a longer chain; the new leaf is prepended). */
  parentPermissionContext: Hex;
  /** From the seller's 402 `extra.facilitatorAddresses` (facilitator `/supported`). */
  facilitatorAddresses: readonly Address[];
  token: Address;
  amount: bigint;
  payTo: Address;
  /** Unix seconds; default now + 600. Must cover the facilitator's verify→settle window. */
  validUntil?: bigint;
  salt?: bigint;
};

/**
 * Build the leaf the agent signs for one payment: open delegate (ANY_DELEGATE) scoped to the
 * facilitator keys, the exact amount, the exact recipient and a short expiry — byte-for-byte what
 * `@metamask/x402`'s `createx402DelegationProvider` emits, so either client works with the facilitator.
 */
export function buildPaymentRedelegation(chainId: number, agent: Address, spec: PaymentRedelegationSpec): Delegation {
  const { enforcers } = erc7710Config(chainId);
  const parents = decodeDelegations(spec.parentPermissionContext);
  if (parents.length === 0) throw new Error("parentPermissionContext holds no delegations");
  if (parents[0].delegate.toLowerCase() !== agent.toLowerCase() && parents[0].delegate !== ANY_DELEGATE) {
    throw new Error(`parent delegation is for ${parents[0].delegate}, not this agent (${agent})`);
  }
  if (spec.facilitatorAddresses.length === 0) throw new Error("facilitatorAddresses is empty — the seller's 402 did not advertise a facilitator");
  return {
    delegate: ANY_DELEGATE,
    delegator: agent,
    authority: delegationHash(parents[0]),
    caveats: [
      { enforcer: enforcers.RedeemerEnforcer, terms: caveatTerms.redeemers(spec.facilitatorAddresses), args: "0x" },
      { enforcer: enforcers.ERC20TransferAmountEnforcer, terms: caveatTerms.erc20TransferAmount(spec.token, spec.amount), args: "0x" },
      { enforcer: enforcers.AllowedCalldataEnforcer, terms: caveatTerms.transferTo(spec.payTo), args: "0x" },
      { enforcer: enforcers.TimestampEnforcer, terms: caveatTerms.timestamp(0n, spec.validUntil ?? BigInt(Math.floor(Date.now() / 1000) + 600)), args: "0x" },
    ],
    salt: spec.salt ?? randomSalt(),
    signature: "0x",
  };
}

/** Sign the leaf with the agent's EOA key and return the full x402 `erc7710` payload. */
export async function signPaymentRedelegation(opts: { chainId: number; agent: LocalAccount; leaf: Delegation; parentPermissionContext: Hex }): Promise<{ delegationManager: Address; permissionContext: Hex; delegator: Address }> {
  const { delegationManager } = erc7710Config(opts.chainId);
  const signature = await opts.agent.signTypedData(delegationTypedData(opts.chainId, delegationManager, opts.leaf));
  const parents = decodeDelegations(opts.parentPermissionContext);
  return {
    delegationManager,
    permissionContext: encodeDelegations([{ ...opts.leaf, signature }, ...parents]),
    delegator: parents[parents.length - 1].delegator,
  };
}
