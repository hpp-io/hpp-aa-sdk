# @hpp-io/aa-sdk

**Smart accounts for [HPP](https://docs.hpp.io).** Let your users sign in with an email wallet, transact
without holding ETH, and give an AI agent a spending limit — in a few lines of TypeScript.

The SDK talks to HPP's own ERC-4337 bundler and paymaster and takes care of HPP's chain-specific details,
so you work with plain `sendCalls([...])`.

📖 **Full documentation: [docs.hpp.io/smart-accounts](https://docs.hpp.io/smart-accounts)**

## What you can do

- **Create a smart account** for any user — their existing address (EIP-7702) or a new one.
- **Send several calls as one transaction** — approve + pay in a single signature.
- **Let users skip ETH** — HPP can cover the gas, or charge it in USDC.e.
- **Pay x402 APIs** from a smart account.
- **Give an agent limited, revocable permissions** — a USDC.e budget for x402 payments, or a session for
  specific contracts.

## Install

```bash
npm i @hpp-io/aa-sdk viem
```

Requires Node.js 20+, ESM (`"type": "module"` or `.mjs`), and `viem` 2.56+. Works in Node and the browser.

## Networks

| | Chain ID | Bundler + paymaster URL | SDK chain |
| --- | --- | --- | --- |
| HPP Mainnet | `190415` | `https://aa.hpp.io/rpc` | `hppMainnet` |
| HPP Sepolia (testnet) | `181228` | `https://aa-sepolia.hpp.io/rpc` | `hppSepolia` |

Start on Sepolia. Test ETH: [HPP Sepolia Faucet](https://faucet.hpp.io/).

## Quickstart

Send USDC.e from a smart account on HPP Sepolia. The account here pays its own gas, so first send about
0.0001 test ETH to the key's address.

```ts
import { createHppAccount, hppSepolia, TOKENS } from "@hpp-io/aa-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi } from "viem";

// 1. Create the account. With a private key, the key's own address becomes the smart account.
const user = await createHppAccount({
  owner: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chain: hppSepolia,
  bundlerUrl: "https://aa-sepolia.hpp.io/rpc",
});

// 2. Make it ready — a one-time setup transaction.
await user.ensureReady();

// 3. Send calls. Everything in the array runs in one transaction.
const USDCe = TOKENS[181228].USDCe;
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const r = await user.sendCalls([
  { to: USDCe, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [user.address, 0n] }) },
]);

console.log(r.success, `https://sepolia-explorer.hpp.io/tx/${r.txHash}`);
```

`sendCalls` does not throw if the transaction was included but reverted — check `r.success`.

Next: [Quickstart in the docs](https://docs.hpp.io/smart-accounts/quickstart) — embedded wallets (Privy),
browser wallets, and paying setup for your users.

## Common tasks

### Let users transact without ETH

Add the policy HPP issued to your app. The SDK picks the right paymaster and tells you what was charged.

```ts
const user = await createHppAccount({
  owner, chain, bundlerUrl,
  paymaster: { policyId: "<your policy>", anchorId: "<this user's anchor>" },
});
const r = await user.sendCalls(calls);
r.fee;   // { mode: "sponsored", … } or { mode: "token", charged, symbol: "USDC.e", … }
```

To get a policy, open a [Gas sponsorship request](https://github.com/hpp-io/hpp-aa-sdk/issues/new/choose).
Keep anchor IDs private. → [Gas sponsorship](https://docs.hpp.io/smart-accounts/gas-sponsorship)

### Use an embedded wallet (Privy, Dynamic, …)

Wrap the wallet's signing functions; the user keeps their address.

```ts
import { toEmbeddedOwner } from "@hpp-io/aa-sdk";

const owner = toEmbeddedOwner({
  address,
  signMessage: (hash) => provider.request({ method: "personal_sign", params: [hash, address] }),
  signTypedData: (td) => provider.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(td, (_, v) => (typeof v === "bigint" ? v.toString() : v))] }),
  signAuthorization,   // the wallet's EIP-7702 authorization signer
});
```

Embedded wallets cannot send the setup transaction themselves, so pass a `sponsor` to `ensureReady`.
→ [Quickstart: embedded wallet](https://docs.hpp.io/smart-accounts/quickstart)

### Pay an x402 API

Use the smart account as the x402 signer. Payments are signatures — no transaction, no gas.

```ts
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const client = new x402HTTPClient(new x402Client().register("eip155:181228", new ExactEvmScheme(user.account)));
```

Sign through the account, not the raw owner key: tokens check signatures with the account's code. Full
example: [`examples/x402-exact.mjs`](examples/x402-exact.mjs).

### Give an agent a budget

```ts
const grant = await user.grantPaymentDelegation({
  agent: agentAddress, token: USDCe, limit: 5_000_000n,           // 5 USDC.e in total
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), // 30 days
});
// give the agent grant.permissionContext; revoke any time:
await user.revokePaymentDelegation(grant.delegation);
```

The agent pays x402 services from the user's account within the limit, enforced on-chain, and never holds
funds. Example: [`examples/x402-erc7710.mjs`](examples/x402-erc7710.mjs). For agents that call contracts
instead, use `grantSession`. → [Agent permissions](https://docs.hpp.io/smart-accounts/agent-permissions)

## When something fails

```ts
import { paymasterReason } from "@hpp-io/aa-sdk";

try { await user.sendCalls(calls); }
catch (e) { console.log(paymasterReason(e)); }   // e.g. "fee_balance_insufficient", or null
```

Every error and how to fix it: [Errors & troubleshooting](https://docs.hpp.io/smart-accounts/errors).

## What the SDK handles for you

If you talk to HPP's bundler without this SDK, you need to handle these yourself:

1. **Gas price** — HPP's priority fee is 0; ask `rundler_getUserOperationGasPrice` instead of a generic estimator.
2. **preVerificationGas** — mostly L1 data cost on HPP; the SDK adds a 15% buffer.
3. **EIP-7702 setup** — sent as its own type-4 transaction, never as a `0x7702` factory marker in a UserOperation.
4. **7702 signatures** — the owner signs the EIP-191-prefixed UserOperation hash.
5. **Session module install** — Kernel needs the `execute` selector in the install data; done in the first operation.
6. **Session nonce key** — type byte `0x01` (a common helper emits `0x00`, which routes to the owner key).
7. **Account signatures (ERC-1271)** — wrapped in the account's Kernel domain so tokens and x402 accept them.
8. **USDC.e gas** — the token paymaster needs a real `paymasterPostOpGasLimit`; the SDK keeps the one the paymaster returns.
9. **Parallel nonce lanes** — a lane's first use costs more gas; the SDK estimates each operation separately.

Details: [Reference → If you bypass the SDK](https://docs.hpp.io/smart-accounts/reference#if-you-bypass-the-sdk).

## Help

- Questions, bugs, sponsorship requests: [open an issue](https://github.com/hpp-io/hpp-aa-sdk/issues/new/choose).
  Never post private keys, anchor IDs, or policy IDs.
- HPP Smart Wallet users: [HPP Telegram](https://t.me/aergoofficial).

## Development

```bash
npm install
npm run build
npm test        # unit tests, no network
```

`examples/` holds the end-to-end scripts we run against HPP Sepolia; the comment at the top of each script
shows how to run it.

## License

MIT
