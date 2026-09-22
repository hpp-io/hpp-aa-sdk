import {
  createPublicClient, createWalletClient, http,
  type Address, type Chain, type Hex, type LocalAccount, type PublicClient, type Transport, type WalletClient,
} from "viem";
import type { BundlerClient, SmartAccount, UserOperationReceipt } from "viem/account-abstraction";
import type { SignedAuthorization } from "viem";
import { ADDRESSES, AA_LIVE_CHAINS } from "./addresses.js";
import { createHppBundlerClient, resolvePaymasterOption, type PaymasterOption } from "./bundler.js";
import { toKernelAccount, type KernelAccountMode, type KernelSmartAccount } from "./account.js";
import { hppSepolia } from "./chains.js";
import { installSmartSessionsCall, kernelAbi, kernelDelegationCode, kernelFactoryAbi, type Call } from "./kernel.js";
import { canSignAuthorization, isLocalAccount, ownerAddress, signAuthorization, type Owner } from "./owner.js";
import { buildSession, enableSessionsCall, isSessionEnabled, removeSessionCall, toSessionAccount, type SessionSmartAccount, type SessionSpec } from "./sessions.js";

export * from "./chains.js";
export * from "./addresses.js";
export * from "./kernel.js";
export * from "./owner.js";
export * from "./bundler.js";
export * from "./account.js";
export * from "./sessions.js";
export * from "./types.js";

export type CreateHppAccountOptions = {
  owner: Owner;
  chain?: Chain;
  bundlerUrl: string;
  rpcUrl?: string;
  /**
   * Gas sponsorship. `{ policyId, anchorId }` = HPP single endpoint with that ERC-7677 context (most apps);
   * `true` / url / PaymasterClient also accepted. Undefined = the account pays its own gas.
   */
  paymaster?: PaymasterOption;
  mode?: KernelAccountMode;
  salt?: Hex;
  pvgBufferPercent?: number;
};

export type SendResult = { userOpHash: Hex; txHash: Hex; success: boolean; receipt: UserOperationReceipt };

/**
 * Who pays for the one-time account setup (7702 delegation tx / factory createAccount tx).
 *  - a funded WalletClient (server-side scripts, tests)
 *  - a RemoteSponsor: the browser sends the signed authorization (or the deploy request) to your backend,
 *    which holds the funded key. The owner never needs ETH.
 */
export type RemoteSponsor = {
  /** 7702: submit a type-4 tx whose authorizationList = [authorization]. Return the tx hash. */
  submitDelegation?: (args: { account: Address; authorization: SignedAuthorization }) => Promise<Hex>;
  /** factory: call KernelFactory.createAccount(initData, salt). Return the tx hash. */
  submitDeploy?: (args: { account: Address; initData: Hex; salt: Hex }) => Promise<Hex>;
};
export type Sponsor = WalletClient | RemoteSponsor;
const isRemoteSponsor = (s: Sponsor): s is RemoteSponsor => !("request" in s);

/**
 * One object per user account. Hides: EntryPoint version, 7702 delegation, Smart Sessions install data,
 * nonce keys, gas price quirks. Developers call `sendCalls`, `grantSession`, `revokeSession`.
 */
export class HppAccount {
  readonly address: Address;
  readonly mode: KernelAccountMode;
  readonly chain: Chain;
  readonly owner: Owner;
  readonly account: KernelSmartAccount;
  readonly client: PublicClient<Transport, Chain>;
  readonly bundler: BundlerClient<Transport, Chain, SmartAccount | undefined>;
  private smartSessionsInstalled: boolean | null = null;

  private constructor(a: Omit<HppAccount, "smartSessionsInstalled" | keyof HppAccountMethods>) {
    this.address = a.address; this.mode = a.mode; this.chain = a.chain; this.owner = a.owner;
    this.account = a.account; this.client = a.client; this.bundler = a.bundler;
  }

  static async create(opts: CreateHppAccountOptions): Promise<HppAccount> {
    const chain = opts.chain ?? hppSepolia;
    if (!AA_LIVE_CHAINS.includes(chain.id)) throw new Error(`HPP AA stack is not deployed on chain ${chain.id}`);
    const client = createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]) });
    const account = await toKernelAccount({ client, owner: opts.owner, mode: opts.mode, salt: opts.salt });
    const bundler = createHppBundlerClient({ chain, bundlerUrl: opts.bundlerUrl, client, account, ...resolvePaymasterOption(opts.paymaster), pvgBufferPercent: opts.pvgBufferPercent });
    return new HppAccount({ address: account.address, mode: account.mode, chain, owner: opts.owner, account, client, bundler } as never);
  }

  /** 7702 mode: is the EOA already delegated to Kernel? Factory mode: is the account deployed? */
  async isReady(): Promise<boolean> {
    const code = (await this.client.getCode({ address: this.address })) ?? "0x";
    return this.mode === "7702" ? code.toLowerCase() === kernelDelegationCode() : code !== "0x";
  }

  /**
   * 7702 mode only: sign the authorization and land the type-4 transaction.
   * `sponsor` (a funded WalletClient) pays the delegation gas so the user needs no ETH;
   * without it the owner sends it themselves (needs ETH). Factory mode needs nothing — the first UserOp deploys.
   */
  async ensureDelegated(opts: { sponsor?: Sponsor } = {}): Promise<Hex | null> {
    if (this.mode !== "7702" || (await this.isReady())) return null;
    if (!canSignAuthorization(this.owner)) throw new Error("owner cannot sign EIP-7702 authorizations — use mode: 'factory'");
    const nonce = await this.client.getTransactionCount({ address: this.address });
    const auth = await signAuthorization(this.owner, { contractAddress: ADDRESSES.kernelV33, chainId: this.chain.id, nonce });
    let hash: Hex;
    if (opts.sponsor && isRemoteSponsor(opts.sponsor)) {
      if (!opts.sponsor.submitDelegation) throw new Error("remote sponsor lacks submitDelegation");
      hash = await opts.sponsor.submitDelegation({ account: this.address, authorization: auth });
    } else {
      const sender: WalletClient = opts.sponsor ?? createWalletClient({ account: this.owner as LocalAccount, chain: this.chain, transport: http(this.chain.rpcUrls.default.http[0]) });
      hash = await sender.sendTransaction({
        account: sender.account!, chain: this.chain, to: this.address, data: "0x", type: "eip7702",
        authorizationList: [auth], gas: 3_000_000n, // Nitro under-estimates type-4 intrinsic gas
      } as never);
    }
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`delegation tx reverted: ${hash}`);
    return hash;
  }

  /**
   * Factory mode only: deploy the account with a normal transaction from `sponsor` (or the owner's own
   * WalletClient) BEFORE the first UserOp. Needed today because KernelFactory is not staked with the
   * EntryPoint, so the bundler's ERC-7562 rules reject `initCode` deployment (validator storage access).
   * Once a staked FactoryStaker is live on HPP this becomes optional and the first UserOp can deploy.
   */
  async ensureDeployed(opts: { sponsor?: Sponsor } = {}): Promise<Hex | null> {
    if (this.mode !== "factory" || (await this.isReady())) return null;
    const { initData, salt } = this.account.factoryArgs;
    let hash: Hex;
    if (opts.sponsor && isRemoteSponsor(opts.sponsor)) {
      if (!opts.sponsor.submitDeploy) throw new Error("remote sponsor lacks submitDeploy");
      hash = await opts.sponsor.submitDeploy({ account: this.address, initData, salt });
    } else {
      const sender: WalletClient | undefined = opts.sponsor ?? (isLocalAccount(this.owner) ? undefined : (this.owner as WalletClient));
      if (!sender) throw new Error("factory mode: pass a funded `sponsor` to deploy the account");
      hash = await sender.writeContract({
        account: sender.account!, chain: this.chain, address: ADDRESSES.kernelFactory, abi: kernelFactoryAbi,
        functionName: "createAccount", args: [initData, salt], gas: 1_500_000n,
      } as never);
    }
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`createAccount reverted: ${hash}`);
    return hash;
  }

  /** Mode-agnostic: delegate (7702) or deploy (factory). Call once per account; no-op afterwards. */
  ensureReady(opts: { sponsor?: Sponsor } = {}): Promise<Hex | null> {
    return this.mode === "7702" ? this.ensureDelegated(opts) : this.ensureDeployed(opts);
  }

  async hasSmartSessions(): Promise<boolean> {
    if (this.smartSessionsInstalled) return true;
    try {
      const ok = await this.client.readContract({ address: this.address, abi: kernelAbi, functionName: "isModuleInstalled", args: [1n, ADDRESSES.smartSessions, "0x"] });
      this.smartSessionsInstalled = ok;
      return ok;
    } catch { return false; } // not delegated / not deployed yet
  }

  /**
   * Send calls as ONE UserOperation (atomic batch), signed by the owner.
   * `setup` (default true) prepends the Smart Sessions install on the first UserOp so sessions work later
   * without an extra transaction.
   */
  async sendCalls(calls: Call[], opts: { setup?: boolean; allowInitCode?: boolean } = {}): Promise<SendResult> {
    if (!(await this.isReady())) {
      if (this.mode === "7702") throw new Error("EOA not delegated — call ensureReady() first");
      // initCode deployment is rejected by the bundler until KernelFactory is staked (ERC-7562). Opt in explicitly.
      if (!opts.allowInitCode) throw new Error("account not deployed — call ensureReady() first (or pass allowInitCode once a staked factory is live)");
    }
    const setup = opts.setup ?? true;
    const all = setup && !(await this.hasSmartSessions()) ? [installSmartSessionsCall(this.address), ...calls] : calls;
    const userOpHash = await this.bundler.sendUserOperation({ account: this.account, calls: all });
    const receipt = await this.bundler.waitForUserOperationReceipt({ hash: userOpHash });
    if (receipt.success && all !== calls) this.smartSessionsInstalled = true;
    return { userOpHash, txHash: receipt.receipt.transactionHash, success: receipt.success, receipt };
  }

  /** Grant an agent a scoped session. One owner signature; the agent then acts without prompts. */
  async grantSession(spec: SessionSpec): Promise<{ permissionId: Hex; result: SendResult }> {
    const { session, permissionId } = buildSession(spec, this.chain.id);
    const result = await this.sendCalls([enableSessionsCall([session])]);
    return { permissionId, result };
  }

  async revokeSession(permissionId: Hex): Promise<SendResult> {
    return this.sendCalls([removeSessionCall(permissionId)], { setup: false });
  }

  isSessionEnabled(permissionId: Hex): Promise<boolean> {
    return isSessionEnabled(this.client, this.address, permissionId);
  }
}
type HppAccountMethods = "isReady" | "ensureDelegated" | "ensureDeployed" | "ensureReady" | "hasSmartSessions" | "sendCalls" | "grantSession" | "revokeSession" | "isSessionEnabled";

export const createHppAccount = HppAccount.create;

export type CreateSessionClientOptions = {
  /** The user's account address. */
  account: Address;
  permissionId: Hex;
  signer: LocalAccount;
  chain?: Chain;
  bundlerUrl: string;
  rpcUrl?: string;
  paymaster?: PaymasterOption;
  pvgBufferPercent?: number;
};

export type HppSessionClient = {
  account: SessionSmartAccount;
  bundler: BundlerClient<Transport, Chain, SmartAccount | undefined>;
  client: PublicClient<Transport, Chain>;
  sendCalls(calls: Call[]): Promise<SendResult>;
};

/** Agent side: act on a user's account within a granted session. */
export async function createHppSessionClient(opts: CreateSessionClientOptions): Promise<HppSessionClient> {
  const chain = opts.chain ?? hppSepolia;
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]) });
  const account = await toSessionAccount({ client, account: opts.account, permissionId: opts.permissionId, signer: opts.signer });
  const bundler = createHppBundlerClient({ chain, bundlerUrl: opts.bundlerUrl, client, account, ...resolvePaymasterOption(opts.paymaster), pvgBufferPercent: opts.pvgBufferPercent });
  return {
    account, bundler, client,
    async sendCalls(calls: Call[]): Promise<SendResult> {
      const userOpHash = await bundler.sendUserOperation({ account, calls });
      const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
      return { userOpHash, txHash: receipt.receipt.transactionHash, success: receipt.success, receipt };
    },
  };
}

export { ownerAddress, isLocalAccount };
