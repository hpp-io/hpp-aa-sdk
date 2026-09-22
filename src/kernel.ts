import {
  concatHex, encodeAbiParameters, encodeFunctionData, pad, parseAbi, toHex, zeroAddress,
  type Address, type Hex,
} from "viem";
import { getSmartSessionsValidator } from "@rhinestone/module-sdk";
import { ADDRESSES, KERNEL_EXECUTE_SELECTOR } from "./addresses.js";

/** Minimal Kernel v3.3 ABI used by the SDK. */
export const kernelAbi = parseAbi([
  "function execute(bytes32 execMode, bytes executionCalldata)",
  "function installModule(uint256 moduleType, address module, bytes initData)",
  "function uninstallModule(uint256 moduleType, address module, bytes deInitData)",
  "function isModuleInstalled(uint256 moduleType, address module, bytes additionalContext) view returns (bool)",
  "function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function rootValidator() view returns (bytes21)",
  "function accountId() view returns (string)",
]);

export const kernelFactoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);

export type Call = { to: Address; value?: bigint; data?: Hex };

/** ERC-7579 exec modes: callType(1) ‖ execType(1) ‖ unused(4) ‖ selector(4) ‖ payload(22). */
export const EXEC_MODE_SINGLE: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const EXEC_MODE_BATCH: Hex = "0x0100000000000000000000000000000000000000000000000000000000000000";

/** Kernel validation types (nonce key byte 1). Root and 7702 share 0x00. */
export const VALIDATION_TYPE_ROOT: Hex = "0x00";
export const VALIDATION_TYPE_VALIDATOR: Hex = "0x01";

/** Hook sentinel meaning "validator installed, no hook" (address(0) would mean not installed). */
export const HOOK_MODULE_INSTALLED: Address = "0x0000000000000000000000000000000000000001";

/** Encode calls as a Kernel `execute` — single call packed, several calls ABI-encoded batch. */
export function encodeKernelExecute(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new Error("encodeKernelExecute: no calls");
  if (calls.length === 1) {
    const c = calls[0];
    const packed = concatHex([c.to, pad(toHex(c.value ?? 0n), { size: 32 }), c.data ?? "0x"]);
    return encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [EXEC_MODE_SINGLE, packed] });
  }
  const batch = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ type: "address", name: "target" }, { type: "uint256", name: "value" }, { type: "bytes", name: "callData" }] }],
    [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? "0x" }))],
  );
  return encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [EXEC_MODE_BATCH, batch] });
}

/**
 * Nonce key for the Smart Sessions validator:
 * [1B mode=0x00][1B type=0x01 VALIDATOR][20B validator][2B key] left-aligned in uint192.
 * (module-sdk's `encodeValidatorNonce` puts type 0x00 here, which routes to the 7702 root key — wrong.)
 */
export function sessionNonceKey(validator: Address = ADDRESSES.smartSessions): bigint {
  return BigInt(pad(concatHex(["0x00", VALIDATION_TYPE_VALIDATOR, validator]), { dir: "right", size: 24 }));
}

/** Nonce key for the root validator (7702 EOA or the factory's ECDSAValidator). */
export const ROOT_NONCE_KEY = 0n;

/**
 * Kernel's 192-bit nonce key ends in a 2-byte lane: [mode][type][validator 20B][lane 2B].
 * viem's default nonceKeyManager passes a Date.now()-based `key`; on Kernel that would overwrite the
 * type/validator bytes and route a session UserOp to the root key. So: only a small explicit `key`
 * (< 65536) is honoured as a lane, anything else means lane 0. Up to 4 lanes may be in flight per account.
 */
export function withLane(base: bigint, key?: bigint): bigint {
  const lane = key !== undefined && key >= 0n && key < 65536n ? key : 0n;
  return base | lane;
}

/**
 * Smart Sessions install data for Kernel:
 * hook(20B, sentinel 0x…01) ‖ abi.encode(validatorData, hookData, selectorData).
 * selectorData MUST contain `execute(bytes32,bytes)`; it cannot be added after install.
 */
export function smartSessionsInstallData(): Hex {
  const ss = getSmartSessionsValidator({});
  return concatHex([
    HOOK_MODULE_INSTALLED,
    encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [ss.initData ?? "0x", "0x", KERNEL_EXECUTE_SELECTOR]),
  ]);
}

/** Self-call that installs Smart Sessions as a validator (module type 1). */
export function installSmartSessionsCall(account: Address): Call {
  return {
    to: account,
    data: encodeFunctionData({ abi: kernelAbi, functionName: "installModule", args: [1n, ADDRESSES.smartSessions, smartSessionsInstallData()] }),
  };
}

/** `initialize` calldata for a factory account whose root is ECDSAValidator(owner). */
export function kernelInitializeData(owner: Address): Hex {
  const rootValidator = concatHex([VALIDATION_TYPE_VALIDATOR, ADDRESSES.kernelEcdsaValidator]); // bytes21
  return encodeFunctionData({ abi: kernelAbi, functionName: "initialize", args: [rootValidator, zeroAddress, owner, "0x", []] });
}

/** Expected `eth_getCode` of an EOA delegated to Kernel. */
export function kernelDelegationCode(impl: Address = ADDRESSES.kernelV33): Hex {
  return ("0xef0100" + impl.slice(2).toLowerCase()) as Hex;
}
