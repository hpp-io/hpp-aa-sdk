import { concatHex, hashMessage, hashTypedData, type Address, type Hex, type SignableMessage } from "viem";
import { readContract } from "viem/actions";
import { VALIDATION_TYPE_ROOT } from "./kernel.js";
import { ownerSignTypedData, type Owner } from "./owner.js";
import type { ChainClient } from "./types.js";

/**
 * ERC-1271 signatures for a Kernel account.
 *
 * A smart account cannot sign EIP-712 payloads (EIP-3009/x402, Permit, Permit2 …) with a plain
 * owner signature: the verifier sees code at the address and calls `isValidSignature` instead of
 * `ecrecover`. This applies to 7702-delegated EOAs too — once delegated, the address has code, and
 * a raw owner signature is rejected (USDC's FiatTokenV2 answers `invalid signature`).
 *
 * Kernel v3 verifies the payload hash **wrapped in the account's own domain**, so the owner signs
 * `Kernel(bytes32 hash)` under `{name:"Kernel", version:"0.3.3", chainId, verifyingContract: account}`,
 * and the signature carries a 1-byte validator selector (`0x00` = root validator).
 */
const KERNEL_WRAPPER_TYPES = { Kernel: [{ name: "hash", type: "bytes32" }] } as const;

const eip712DomainAbi = [{
  type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
  outputs: [
    { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" },
    { type: "address" }, { type: "bytes32" }, { type: "uint256[]" },
  ],
}] as const;

/** The account's EIP-712 domain. Read from the account when deployed; the Kernel v3.3 constants otherwise. */
export async function kernelDomain(client: ChainClient, account: Address) {
  const fallback = { name: "Kernel", version: "0.3.3", chainId: client.chain.id, verifyingContract: account } as const;
  try {
    const d = await readContract(client, { address: account, abi: eip712DomainAbi, functionName: "eip712Domain" });
    return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    return fallback;
  }
}

/** Wrap a payload hash the way Kernel's `isValidSignature` does before checking it. */
export async function kernelWrappedHash(client: ChainClient, account: Address, hash: Hex): Promise<Hex> {
  return hashTypedData({ domain: await kernelDomain(client, account), types: KERNEL_WRAPPER_TYPES, primaryType: "Kernel", message: { hash } });
}

/**
 * Sign `hash` so that `account.isValidSignature(hash, sig)` returns the ERC-1271 magic value.
 * The owner signs the wrapped hash as typed data — an EIP-191 (`personal_sign`) signature is rejected.
 */
export async function signErc1271Hash(opts: { client: ChainClient; account: Address; owner: Owner; hash: Hex }): Promise<Hex> {
  const domain = await kernelDomain(opts.client, opts.account);
  const signature = await ownerSignTypedData(opts.owner, { domain, types: KERNEL_WRAPPER_TYPES, primaryType: "Kernel", message: { hash: opts.hash } });
  return concatHex([VALIDATION_TYPE_ROOT, signature]);
}

/** ERC-1271 signature over an EIP-712 payload — what x402 `exact` (EIP-3009), Permit and Permit2 need. */
export async function signErc1271TypedData(opts: { client: ChainClient; account: Address; owner: Owner; typedData: Parameters<typeof hashTypedData>[0] }): Promise<Hex> {
  return signErc1271Hash({ ...opts, hash: hashTypedData(opts.typedData) });
}

/** ERC-1271 signature over an EIP-191 message. */
export async function signErc1271Message(opts: { client: ChainClient; account: Address; owner: Owner; message: SignableMessage }): Promise<Hex> {
  return signErc1271Hash({ ...opts, hash: hashMessage(opts.message) });
}
