import { keccak256, toFunctionSelector, toHex, type Address, type Hex, type LocalAccount } from "viem";
import type { ChainClient } from "./types.js";
import { readContract } from "viem/actions";
import { entryPoint07Abi, getUserOperationHash, toSmartAccount, type SmartAccount, type SmartAccountImplementation } from "viem/account-abstraction";
import {
  SmartSessionMode, encodeSmartSessionSignature, encodeValidationData, getEnableSessionsAction, getOwnableValidator,
  getOwnableValidatorMockSignature, getPermissionId, getRemoveSessionAction, getSpendingLimitsPolicy, getSudoPolicy,
  getTimeFramePolicy, getUsageLimitPolicy, getValueLimitPolicy, type Session,
} from "@rhinestone/module-sdk";
import { ADDRESSES } from "./addresses.js";
import { encodeKernelExecute, sessionNonceKey, withLane, type Call } from "./kernel.js";

export type PolicyRef = { address: Address; initData: Hex };

export type ActionSpec = {
  target: Address;
  /** Either a 4-byte selector … */
  selector?: Hex;
  /** … or a human signature like "transfer(address,uint256)". */
  signature?: string;
  /** Action-level policies. Defaults to sudo (any args) plus any matching `spend` limit. */
  policies?: PolicyRef[];
};

export type SessionSpec = {
  /** The agent key that will sign UserOps for this session. */
  signer: Address;
  /** What the agent may call. Anything else is rejected at validation (no gas spent). */
  actions: ActionSpec[];
  /** ERC-20 spending caps, applied to actions whose target is that token. Cumulative for the session's life. */
  spend?: { token: Address; limit: bigint }[];
  /** Max native value per UserOp (wei). */
  valueLimit?: bigint;
  /** Max number of UserOps. */
  usageLimit?: bigint;
  /** Unix seconds. */
  validUntil?: number;
  validAfter?: number;
  salt?: Hex;
};

export type BuiltSession = { session: Session; permissionId: Hex };

const DUMMY_OWNER = "0x0000000000000000000000000000000000000001" as const;

/** Translate a SessionSpec into a Smart Sessions `Session` for Kernel + its permissionId. */
export function buildSession(spec: SessionSpec, chainId: number): BuiltSession {
  const spendByToken = new Map((spec.spend ?? []).map((s) => [s.token.toLowerCase(), s.limit]));

  const actions = spec.actions.map((a) => {
    const selector = a.selector ?? (a.signature ? toFunctionSelector(a.signature) : undefined);
    if (!selector) throw new Error(`action ${a.target}: selector or signature required`);
    const policies: PolicyRef[] = [...(a.policies ?? [])];
    const limit = spendByToken.get(a.target.toLowerCase());
    if (limit !== undefined) policies.push(getSpendingLimitsPolicy([{ token: a.target, limit }]));
    if (policies.length === 0) policies.push(getSudoPolicy());
    return { actionTarget: a.target, actionTargetSelector: selector, actionPolicies: policies.map((p) => ({ policy: p.address, initData: p.initData })) };
  });

  const userOpPolicies: PolicyRef[] = [];
  if (spec.usageLimit !== undefined) userOpPolicies.push(getUsageLimitPolicy({ limit: spec.usageLimit }));
  if (spec.validUntil !== undefined || spec.validAfter !== undefined)
    userOpPolicies.push(getTimeFramePolicy({ validUntil: spec.validUntil ?? 0, validAfter: spec.validAfter ?? 0 }));
  if (spec.valueLimit !== undefined) userOpPolicies.push(getValueLimitPolicy({ limit: spec.valueLimit }));
  if (userOpPolicies.length === 0) userOpPolicies.push(getSudoPolicy());

  const session: Session = {
    sessionValidator: getOwnableValidator({ owners: [DUMMY_OWNER], threshold: 1 }).address,
    sessionValidatorInitData: encodeValidationData({ threshold: 1, owners: [spec.signer] }),
    salt: spec.salt ?? keccak256(toHex(`hpp-aa-${spec.signer}-${Date.now()}-${Math.random()}`)),
    userOpPolicies: userOpPolicies.map((p) => ({ policy: p.address, initData: p.initData })),
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions,
    permitERC4337Paymaster: true,
    chainId: BigInt(chainId),
  };
  return { session, permissionId: getPermissionId({ session }) };
}

/** Call (from the account itself) that enables one or more sessions. */
export function enableSessionsCall(sessions: Session[]): Call {
  const a = getEnableSessionsAction({ sessions });
  return { to: (a.target ?? a.to) as Address, data: (a.callData ?? a.data) as Hex, value: 0n };
}

/** Call (from the account itself) that revokes a session. Takes effect immediately. */
export function removeSessionCall(permissionId: Hex): Call {
  const a = getRemoveSessionAction({ permissionId });
  return { to: (a.target ?? a.to) as Address, data: (a.callData ?? a.data) as Hex, value: 0n };
}

export async function isSessionEnabled(client: ChainClient, account: Address, permissionId: Hex): Promise<boolean> {
  return readContract(client, {
    address: ADDRESSES.smartSessions,
    abi: [{ type: "function", name: "isPermissionEnabled", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }],
    functionName: "isPermissionEnabled",
    args: [permissionId, account],
  });
}

export type ToSessionAccountOptions = {
  client: ChainClient;
  /** The user's Kernel account (7702 EOA address or factory address). */
  account: Address;
  permissionId: Hex;
  /** Agent key — must be able to produce raw ECDSA over a hash (`LocalAccount.sign`). */
  signer: LocalAccount;
};

type SessionExtend = { permissionId: Hex; signer: LocalAccount };
export type SessionSmartAccount = SmartAccount<SmartAccountImplementation<typeof entryPoint07Abi, "0.7", SessionExtend>>;

/**
 * viem SmartAccount an agent uses to act on the user's account within a session:
 *  - nonce key routes to the Smart Sessions validator (type 0x01)
 *  - signature = encodeSmartSessionSignature(USE, permissionId, ecdsa(userOpHash))
 */
export async function toSessionAccount(opts: ToSessionAccountOptions): Promise<SessionSmartAccount> {
  const { client, account, permissionId, signer } = opts;
  if (typeof signer.sign !== "function") throw new Error("session signer must support raw `sign({ hash })`");
  const key = sessionNonceKey();
  const wrap = (signature: Hex) => encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature });

  return toSmartAccount<SmartAccountImplementation<typeof entryPoint07Abi, "0.7", SessionExtend>>({
    client,
    entryPoint: { abi: entryPoint07Abi, address: ADDRESSES.entryPoint07, version: "0.7" },
    extend: { permissionId, signer },
    getAddress: async () => account,
    encodeCalls: async (calls) => encodeKernelExecute(calls),
    getFactoryArgs: async () => ({}),
    getNonce: async (p) =>
      readContract(client, { address: ADDRESSES.entryPoint07, abi: entryPoint07Abi, functionName: "getNonce", args: [account, withLane(key, p?.key)] }),
    getStubSignature: async () => wrap(getOwnableValidatorMockSignature({ threshold: 1 })),
    signUserOperation: async (uo) => {
      const hash = getUserOperationHash({ chainId: uo.chainId ?? client.chain.id, entryPointAddress: ADDRESSES.entryPoint07, entryPointVersion: "0.7", userOperation: { ...uo, sender: account, signature: "0x" } as never });
      return wrap(await signer.sign!({ hash }));
    },
    signMessage: async () => { throw new Error("session accounts cannot sign ERC-1271 messages"); },
    signTypedData: async () => { throw new Error("session accounts cannot sign ERC-1271 typed data"); },
  });
}
