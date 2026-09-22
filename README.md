# @hpp-io/aa-sdk

HPP Account Abstraction SDK. Kernel v3.3 smart accounts on HPP (EIP-7702 or factory), Smart Sessions for agents,
and the HPP bundler — with the chain-specific pitfalls handled inside the library.

> Status: **HPP Sepolia only** (chain 181228). Gas is paid by the account until the HPP paymaster is live.

## Quickstart — 3 steps

```bash
npm i @hpp-io/aa-sdk viem
```

Source: [github.com/hpp-io/hpp-aa-sdk](https://github.com/hpp-io/hpp-aa-sdk) · Infra & guide: [hpp-io/hpp-bundler](https://github.com/hpp-io/hpp-bundler) (`docs/DEVELOPER_GUIDE.md`) · Example app: [hpp-io/hpp-aa-examples](https://github.com/hpp-io/hpp-aa-examples)

```ts
import { createHppAccount, hppSepolia, TOKENS } from "@hpp-io/aa-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi } from "viem";

// 1. an account. `owner` is any viem LocalAccount (Privy/Dynamic embedded signer, server key)
//    or a WalletClient from a browser wallet (MetaMask, Rabby …).
const user = await createHppAccount({ owner: privateKeyToAccount(KEY), chain: hppSepolia, bundlerUrl: BUNDLER_URL });
await user.ensureReady({ sponsor });              // once. 7702: delegation tx · factory: createAccount tx. `sponsor` pays.

// 2. send calls — one UserOperation, atomic. approve + pay in a single prompt.
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
await user.sendCalls([{ to: TOKENS[181228].USDCe, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, 1_000_000n] }) }]);

// 3. delegate to an agent — one signature, then the agent acts within the limits, no prompts.
const { permissionId } = await user.grantSession({
  signer: agent.address,
  actions: [{ target: TOKENS[181228].USDCe, signature: "transfer(address,uint256)" }],
  spend: [{ token: TOKENS[181228].USDCe, limit: 5_000_000n }],   // 5 USDC.e total
  validUntil: Math.floor(Date.now() / 1000) + 30 * 86400,
});
```

Agent side:

```ts
import { createHppSessionClient } from "@hpp-io/aa-sdk";
const agentClient = await createHppSessionClient({ account: user.address, permissionId, signer: agentKey, bundlerUrl: BUNDLER_URL });
await agentClient.sendCalls([{ to: USDCe, data: transferCalldata }]);   // over the cap → rejected at validation, no gas spent
```

Revoke: `await user.revokeSession(permissionId)`.

**Result handling**: `sendCalls`, `grantSession`, `revokeSession` return `{ success, txHash, userOpHash, receipt }` and do **not** throw when the
UserOperation was mined but its execution reverted (`success: false`). They *do* throw when the bundler or paymaster rejects the
request before inclusion (validation revert, policy denial, budget exhausted). Check `success` after every call.

## Gas sponsorship (ERC-7677)

The HPP paymaster shares the bundler URL and takes `{ policyId, anchorId? }` as the 7677 context. `policyId` is your
app's policy (issued by HPP ops); `anchorId` is the per-user entitlement your **backend** attaches for the logged-in
user — never something the end user types. Rejections arrive as JSON-RPC `-32000` with `data.reason`
(`policy_required`, `anchor_unknown`, `budget_exceeded`, …). Signatures are short-lived (policy default 5 min): send right away.

```ts
const user = await createHppAccount({ owner, chain: hppSepolia, bundlerUrl, paymaster: { policyId, anchorId } });
await user.sendCalls([...]);        // account holds 0 ETH; the paymaster's deposit pays
```

`paymaster` also accepts `true` (same URL, no context), a separate URL, or a viem `PaymasterClient`. The
`createHppSessionClient` agent side takes the same option, so agent UserOps can be sponsored under the same policy.
Note: the stub (`pm_getPaymasterStubData`) is not policy-checked; the decision happens at `pm_getPaymasterData`,
i.e. inside `sendCalls`.

## Who pays for setup? (`sponsor`)

`ensureReady({ sponsor })` accepts either a funded viem `WalletClient` (scripts, servers) or a `RemoteSponsor`
for browser apps — the page signs, your backend broadcasts:

```ts
const sponsor = {
  submitDelegation: ({ account, authorization }) => post("/api/sponsor", { type: "delegate", account, authorization }),
  submitDeploy:     ({ account, initData, salt }) => post("/api/sponsor", { type: "deploy", account, initData, salt }),
};
await user.ensureReady({ sponsor });   // owner never needs ETH for setup
```

## Embedded wallets (Privy, Dynamic, Turnkey …)

The SDK never touches a private key. Give it the two primitives every embedded-wallet SDK exposes and it
takes the 7702 path (same address, no new deposit):

```ts
import { toEmbeddedOwner } from "@hpp-io/aa-sdk";
// Privy (react)
const { signMessage } = useSignMessage();
const { signAuthorization } = useSignAuthorization();
const owner = toEmbeddedOwner({
  address: wallet.address,
  signMessage: (hash) => signMessage({ message: { raw: hash } }, { address: wallet.address }).then((r) => r.signature),
  signAuthorization: (a) => signAuthorization({ contractAddress: a.contractAddress, chainId: a.chainId, nonce: a.nonce }, { address: wallet.address }),
});
const user = await createHppAccount({ owner, chain: hppSepolia, bundlerUrl });
```

Leave out `signAuthorization` for a wallet that cannot sign type-4 authorizations and the account becomes a
factory account automatically. HPP is a custom chain for these vendors: register it with viem's `defineChain`
(`hppSepolia` is exactly that) — no vendor-side approval is needed, since signing is chain-agnostic.

## Which account mode?

| owner | mode | address | how it becomes a smart account |
|---|---|---|---|
| LocalAccount that can `signAuthorization` (embedded wallets, server keys) | `7702` (default) | **same as the EOA** | `ensureDelegated()` sends one type-4 tx |
| WalletClient from a browser wallet (no 7702 signing exposed to dapps) | `factory` (auto) | new counterfactual address | `ensureReady({ sponsor })` calls `KernelFactory.createAccount` (initCode deployment needs a staked factory — not yet on HPP) |

Both modes share everything after that: batching, sessions, revocation. Force a mode with `mode: "factory"`.

## What the SDK handles for you (the six HPP pitfalls)

1. **Fees** — `rundler_getUserOperationGasPrice`, not viem's estimator (priority fee is 0 on HPP).
2. **preVerificationGas** — +15 % buffer by default (`pvgBufferPercent`); HPP gas is ~98 % L1 data.
3. **7702 factory marker** — delegation is a separate type-4 tx, so UserOps never carry `factory: "0x7702"`.
4. **7702 UserOp hash / signature** — root signs EIP-191(userOpHash), verified by Kernel against `address(this)`.
5. **Kernel validator install** — Smart Sessions `initData` includes the `execute` selector; installed inside the first UserOp.
6. **Session nonce** — nonce key type `0x01` (module-sdk's helper emits `0x00`, which routes to the root key).

## Layout

- `chains.ts` — `hppSepolia`, `hppMainnet`
- `addresses.ts` — canonical addresses, `TOKENS`
- `bundler.ts` — `createHppBundlerClient` (fees, pVG buffer, ERC-7677 paymaster hook)
- `account.ts` — `toKernelAccount` (viem `SmartAccount`, 7702 / factory)
- `sessions.ts` — `buildSession`, `enableSessionsCall`, `removeSessionCall`, `toSessionAccount`
- `index.ts` — `HppAccount` / `createHppAccount`, `createHppSessionClient`

## Tests

```bash
npm test                                       # encoding unit tests (byte layouts proven by test/cases/*)
PAYER_KEY=0x… npm run e2e                       # Sepolia e2e, 7702 path (sponsor = examples/.sdk-test-sponsor.json; never the refill funder)
RELAYER_KEY=0x… PAYER_KEY=0x… MODE=factory node examples/e2e-sepolia.mjs
RELAYER_KEY=0x… PAYER_KEY=0x… OWNER=embedded node examples/e2e-sepolia.mjs   # 7702 through toEmbeddedOwner
RELAYER_KEY=0x… PAYER_KEY=0x… PAYMASTER_URL=… POLICY_ID=… ANCHOR_ID=… node examples/e2e-sepolia.mjs   # sponsored: account ETH stays 0
PAYMASTER_URL=… DELEGATED_ACCOUNT_KEY=0x… node examples/paymaster-stub-check.mjs   # stub+estimate only, reserves nothing
```
