import {
  encodeFunctionData, toHex, type Address, type Hex,
} from "viem";
import { readContract } from "viem/actions";
import {
  entryPoint07Abi, getUserOperationHash, toSmartAccount,
  type SmartAccount, type SmartAccountImplementation,
} from "viem/account-abstraction";
import { ADDRESSES } from "./addresses.js";
import {
  ROOT_NONCE_KEY, encodeKernelExecute, kernelFactoryAbi, kernelInitializeData, withLane,
} from "./kernel.js";
import { signErc1271Message, signErc1271TypedData } from "./erc1271.js";
import { canSignAuthorization, ownerAddress, signHashPrefixed, type Owner } from "./owner.js";
import type { ChainClient } from "./types.js";

export type KernelAccountMode =
  /** Owner EOA is (or will be) delegated to Kernel via EIP-7702 — same address. */
  | "7702"
  /** Counterfactual Kernel deployed by KernelFactory, root = ECDSAValidator(owner) — new address. */
  | "factory";

export type ToKernelAccountOptions = {
  client: ChainClient;
  owner: Owner;
  /** Defaults to "7702" when the owner can sign authorizations (local/embedded keys), else "factory". */
  mode?: KernelAccountMode;
  /** Factory mode only. Different salts give the same owner several accounts. */
  salt?: Hex;
};

/** Dummy ECDSA signature used for gas estimation (65 bytes, recovers to garbage, does not revert). */
export const STUB_ECDSA_SIGNATURE: Hex =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

type KernelExtend = { mode: KernelAccountMode; owner: Owner; ownerAddress: Address; /** factory mode: what `createAccount` needs */ factoryArgs: { initData: Hex; salt: Hex } };
export type KernelSmartAccount = SmartAccount<SmartAccountImplementation<typeof entryPoint07Abi, "0.7", KernelExtend>>;

const ENTRY_POINT = { abi: entryPoint07Abi, address: ADDRESSES.entryPoint07, version: "0.7" as const };

/**
 * viem SmartAccount for Kernel v3.3 on HPP, signed by the account's root:
 *  - 7702 mode: Kernel's VALIDATION_TYPE_7702 → ecrecover(EIP-191(userOpHash)) == address(this)
 *  - factory mode: ECDSAValidator(owner) — accepts raw or EIP-191; we always send EIP-191 so browser wallets work
 * Delegation (7702) is NOT done through the UserOp (`factory: "0x7702"` marker is rejected by the bundler);
 * use `HppAccount.ensureDelegated()` — see index.ts.
 */
export async function toKernelAccount(opts: ToKernelAccountOptions): Promise<KernelSmartAccount> {
  const { client, owner } = opts;
  const ownerAddr = ownerAddress(owner);
  const mode: KernelAccountMode = opts.mode ?? (canSignAuthorization(owner) ? "7702" : "factory");
  const salt: Hex = opts.salt ?? toHex(0n, { size: 32 });
  const initData = kernelInitializeData(ownerAddr);

  const getAddress = async (): Promise<Address> =>
    mode === "7702"
      ? ownerAddr
      : readContract(client, { address: ADDRESSES.kernelFactory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, salt] });

  const address = await getAddress();

  return toSmartAccount<SmartAccountImplementation<typeof entryPoint07Abi, "0.7", KernelExtend>>({
    client,
    entryPoint: ENTRY_POINT,
    extend: { mode, owner, ownerAddress: ownerAddr, factoryArgs: { initData, salt } },
    getAddress: async () => address,
    encodeCalls: async (calls) => encodeKernelExecute(calls),
    getFactoryArgs: async () =>
      mode === "7702"
        ? {}
        : { factory: ADDRESSES.kernelFactory, factoryData: encodeFunctionData({ abi: kernelFactoryAbi, functionName: "createAccount", args: [initData, salt] }) },
    getNonce: async (p) =>
      readContract(client, { address: ADDRESSES.entryPoint07, abi: entryPoint07Abi, functionName: "getNonce", args: [address, withLane(ROOT_NONCE_KEY, p?.key)] }),
    getStubSignature: async () => STUB_ECDSA_SIGNATURE,
    signUserOperation: async (uo) => {
      const chainId = uo.chainId ?? client.chain.id;
      const hash = getUserOperationHash({ chainId, entryPointAddress: ADDRESSES.entryPoint07, entryPointVersion: "0.7", userOperation: { ...uo, sender: address, signature: "0x" } as never });
      return signHashPrefixed(owner, hash);
    },
    // ERC-1271: Kernel checks the payload hash wrapped in the account's own domain, so the owner
    // signature alone is not enough — see erc1271.ts. Applies to 7702 accounts too (they have code).
    signMessage: async ({ message }) => signErc1271Message({ client, account: address, owner, message }),
    signTypedData: async (td) => signErc1271TypedData({ client, account: address, owner, typedData: td as never }),
  });
}
