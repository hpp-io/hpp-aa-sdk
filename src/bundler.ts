import { http, type Chain, type Client, type Hex, type Transport } from "viem";
import {
  createBundlerClient, createPaymasterClient, estimateUserOperationGas,
  type BundlerClient, type PaymasterClient, type SmartAccount,
} from "viem/account-abstraction";

export type HppBundlerOptions = {
  chain: Chain;
  /** HPP bundler JSON-RPC URL (eth_* + rundler_*; pm_* once the single endpoint is live). */
  bundlerUrl: string;
  /** Public client for chain reads. Defaults to the chain's default RPC. */
  client?: Client;
  account?: SmartAccount;
  /**
   * Gas sponsorship (ERC-7677):
   *  - `true`   → the bundler URL also serves pm_* (HPP single endpoint)
   *  - string   → separate paymaster URL
   *  - PaymasterClient → bring your own
   *  - undefined → user pays gas
   */
  paymaster?: true | string | PaymasterClient;
  /**
   * Sent as the 4th param of pm_getPaymasterStubData / pm_getPaymasterData.
   * HPP paymaster: `{ policyId, anchorId? }` — policyId is your app's configured policy; anchorId is the
   * per-user entitlement your backend attaches (required when the policy has a per-anchor cap).
   * Rejections come back as JSON-RPC -32000 with `data.reason` (policy_required, anchor_unknown, budget_exceeded …).
   */
  paymasterContext?: HppPaymasterContext;
  /** Extra preVerificationGas on top of the bundler estimate, in percent. HPP gas is ~98% L1 data cost. */
  pvgBufferPercent?: number;
};

type GasPrice = { suggested: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };

export type HppPaymasterContext = { policyId: string; anchorId?: string } & Record<string, unknown>;

/** Shorthand accepted by createHppAccount: `{ policyId, anchorId }` means "same URL as the bundler, with this context". */
export type PaymasterOption = true | string | PaymasterClient | ({ url?: string } & HppPaymasterContext);

export function resolvePaymasterOption(p: PaymasterOption | undefined): { paymaster?: true | string | PaymasterClient; paymasterContext?: HppPaymasterContext } {
  if (p === undefined || p === true || typeof p === "string") return { paymaster: p };
  if ("policyId" in p) { const { url, ...context } = p; return { paymaster: url ?? true, paymasterContext: context }; }
  return { paymaster: p as PaymasterClient };
}

/**
 * Bundler client with the HPP specifics baked in:
 *  ① fees come from `rundler_getUserOperationGasPrice` (priority fee is 0 on HPP; SDK defaults over-estimate)
 *  ② preVerificationGas gets a buffer (L1 data price moves between estimate and inclusion)
 *  ③ optional ERC-7677 paymaster
 */
export function createHppBundlerClient(opts: HppBundlerOptions): BundlerClient<Transport, Chain, SmartAccount | undefined> {
  const { chain, bundlerUrl, client, account, pvgBufferPercent = 15, paymasterContext } = opts;
  const paymaster =
    opts.paymaster === true ? createPaymasterClient({ transport: http(bundlerUrl) })
    : typeof opts.paymaster === "string" ? createPaymasterClient({ transport: http(opts.paymaster) })
    : opts.paymaster;

  const base = createBundlerClient({
    account,
    chain,
    client,
    transport: http(bundlerUrl),
    paymaster,
    paymasterContext,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const r = (await bundlerClient.request({ method: "rundler_getUserOperationGasPrice" as never, params: [] as never })) as GasPrice;
        return { maxFeePerGas: BigInt(r.suggested.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.suggested.maxPriorityFeePerGas) };
      },
    },
  });

  const bump = BigInt(100 + Math.max(0, Math.floor(pvgBufferPercent)));
  return base.extend((c) => ({
    async estimateUserOperationGas(args: Parameters<typeof estimateUserOperationGas>[1]) {
      const est = await estimateUserOperationGas(c as never, args as never);
      return { ...est, preVerificationGas: (est.preVerificationGas * bump) / 100n };
    },
  })) as unknown as BundlerClient<Transport, Chain, SmartAccount | undefined>;
}
