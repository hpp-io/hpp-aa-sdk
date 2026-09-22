import { toHex, type Address, type Hex, type LocalAccount, type SignableMessage, type WalletClient } from "viem";
import { toAccount } from "viem/accounts";
import type { SignAuthorizationReturnType } from "viem/accounts";

/**
 * Anything that can own an HPP account:
 * - a viem LocalAccount (private key, Privy/Dynamic embedded signer, server key)
 * - a WalletClient backed by a browser wallet (MetaMask, Rabby, Coinbase Wallet EOA …)
 */
export type Owner = LocalAccount | WalletClient;

export function isLocalAccount(o: Owner): o is LocalAccount {
  return (o as LocalAccount).type === "local";
}

export function ownerAddress(o: Owner): Address {
  if (isLocalAccount(o)) return o.address;
  const a = o.account?.address;
  if (!a) throw new Error("WalletClient has no account attached");
  return a;
}

/** EIP-191 personal_sign over a 32-byte hash — what Kernel's 7702 root and ECDSAValidator verify. */
export async function signHashPrefixed(o: Owner, hash: Hex): Promise<Hex> {
  if (isLocalAccount(o)) return o.signMessage({ message: { raw: hash } });
  return o.signMessage({ account: o.account!, message: { raw: hash } });
}

/** ERC-1271-style message signing by the owner (used for the 7702 root's isValidSignature). */
export async function ownerSignMessage(o: Owner, message: SignableMessage): Promise<Hex> {
  if (isLocalAccount(o)) return o.signMessage({ message });
  return o.signMessage({ account: o.account!, message });
}

export async function ownerSignTypedData(o: Owner, typedData: unknown): Promise<Hex> {
  if (isLocalAccount(o)) return (o.signTypedData as (a: never) => Promise<Hex>)(typedData as never);
  return (o.signTypedData as (a: never) => Promise<Hex>)({ account: o.account, ...(typedData as object) } as never);
}

/** True when the owner can produce an EIP-7702 authorization (embedded wallets, local keys). Browser wallets cannot. */
export function canSignAuthorization(o: Owner): boolean {
  return isLocalAccount(o) && typeof o.signAuthorization === "function";
}

export async function signAuthorization(
  o: Owner,
  args: { contractAddress: Address; chainId: number; nonce: number },
): Promise<SignAuthorizationReturnType> {
  if (!isLocalAccount(o) || !o.signAuthorization) throw new Error("owner cannot sign EIP-7702 authorizations");
  return o.signAuthorization(args);
}

/**
 * Wrap an embedded-wallet signer (Privy, Dynamic, Turnkey, a KMS …) as an Owner.
 * Provide the raw primitives the vendor SDK exposes; `signAuthorization` unlocks the 7702 path
 * (same address), without it the account falls back to factory mode.
 *
 *   // Privy (react): const { signMessage } = useSignMessage(); const { signAuthorization } = useSignAuthorization();
 *   const owner = toEmbeddedOwner({
 *     address: wallet.address,
 *     signMessage: (hash) => signMessage({ message: { raw: hash } }, { address: wallet.address }).then(r => r.signature),
 *     signAuthorization: (auth) => signAuthorization({ contractAddress: auth.contractAddress, chainId: auth.chainId, nonce: auth.nonce }, { address: wallet.address }),
 *   });
 */
export function toEmbeddedOwner(source: {
  address: Address;
  /** EIP-191 personal_sign over raw bytes (hex). The SDK passes 32-byte userOp hashes; ERC-1271 callers may pass longer payloads. */
  signMessage: (hash: Hex) => Promise<Hex>;
  /** EIP-7702 authorization signer. Optional — omit for wallets that cannot sign type-4 authorizations. */
  signAuthorization?: (auth: { contractAddress: Address; chainId: number; nonce: number }) => Promise<SignAuthorizationReturnType>;
  signTypedData?: (typedData: unknown) => Promise<Hex>;
}): LocalAccount {
  const account = toAccount({
    address: source.address,
    signMessage: async ({ message }) => {
      const raw = typeof message === "string" ? toHex(message) : "raw" in message ? message.raw : message;
      const hash = typeof raw === "string" ? raw : toHex(raw);
      return source.signMessage(hash);
    },
    signTypedData: async (td) => {
      if (!source.signTypedData) throw new Error("embedded owner: signTypedData not provided");
      return source.signTypedData(td);
    },
    signTransaction: async () => { throw new Error("embedded owner: signTransaction not supported — the SDK never signs transactions with the owner"); },
    ...(source.signAuthorization
      ? { signAuthorization: async (auth: { contractAddress?: Address; address?: Address; chainId: number; nonce: number }) =>
            source.signAuthorization!({ contractAddress: (auth.contractAddress ?? auth.address)!, chainId: auth.chainId, nonce: auth.nonce }) }
      : {}),
  }) as LocalAccount;
  return account;
}
