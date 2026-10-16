// Checks the sponsorship path without reserving anything: a 7702 Kernel account (0 ETH) runs only pm_getPaymasterStubData + eth_estimateUserOperationGas.
// It never calls pm_getPaymasterData or sends, which would consume policy budget and anchor quota.
//   PAYMASTER_URL=http://localhost:24338/rpc POLICY_ID=l1-onboarding ANCHOR_ID=anchor-dev-1 node examples/paymaster-stub-check.mjs
import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hppSepolia, ADDRESSES, toKernelAccount, createHppBundlerClient, resolvePaymasterOption, kernelDelegationCode } from "../dist/index.js";
import { createPaymasterClient } from "viem/account-abstraction";

const PM = process.env.PAYMASTER_URL ?? "http://localhost:24338/rpc";
const ctx = { policyId: process.env.POLICY_ID ?? "l1-onboarding", anchorId: process.env.ANCHOR_ID ?? "anchor-dev-1" };
const chain = hppSepolia;
const client = createPublicClient({ chain, transport: http() });
const log = (k, v) => console.log(`[${k}]`, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

// Needs an account already delegated to Kernel (validation requires code at the address).
const known = process.env.DELEGATED_ACCOUNT_KEY ? privateKeyToAccount(process.env.DELEGATED_ACCOUNT_KEY) : null;
const owner = known ?? privateKeyToAccount(generatePrivateKey());
const account = await toKernelAccount({ client, owner, mode: "7702" });
const code = (await client.getCode({ address: account.address })) ?? "0x";
log("0_account", { address: account.address, delegated: code.toLowerCase() === kernelDelegationCode(), eth: (await client.getBalance({ address: account.address })).toString() });
if (code.toLowerCase() !== kernelDelegationCode()) { console.log("A Kernel-delegated account is required (DELEGATED_ACCOUNT_KEY). Exiting."); process.exit(2); }

const bundler = createHppBundlerClient({ chain, bundlerUrl: PM, client, account, ...resolvePaymasterOption({ url: PM, ...ctx }) });
const pm = createPaymasterClient({ transport: http(PM) });
const mc = parseAbi(["function getBlockNumber() view returns (uint256)"]);
const calls = [{ to: ADDRESSES.multicall3, data: encodeFunctionData({ abi: mc, functionName: "getBlockNumber" }) }];

// 1) stub: viem calls pm_getPaymasterStubData(userOp, EP, chainId, context) and fills the paymaster fields (no reservation)
const stub = await pm.getPaymasterStubData({ chainId: chain.id, entryPointAddress: ADDRESSES.entryPoint07, context: ctx, sender: account.address, nonce: 0n, callData: "0x" });
log("1_stub", { paymaster: stub.paymaster, isFinal: stub.isFinal, pmVerificationGas: stub.paymasterVerificationGasLimit, pmPostOpGas: stub.paymasterPostOpGasLimit, dataBytes: (stub.paymasterData.length - 2) / 2 });

// 2) prepare: stub → estimate only (pm_getPaymasterData is called only by sendUserOperation, so nothing is reserved here)
const uo = await bundler.prepareUserOperation({ account, calls, parameters: ["factory", "fees", "gas", "nonce", "paymaster", "signature"] });
log("2_prepared", { paymaster: uo.paymaster, callGas: uo.callGasLimit, verGas: uo.verificationGasLimit, pVG: uo.preVerificationGas, pmVerGas: uo.paymasterVerificationGasLimit, maxFee: uo.maxFeePerGas });

// 3) rejection without reservation: an unknown policy must return policy_not_found at the stub step
try { await pm.getPaymasterStubData({ chainId: chain.id, entryPointAddress: ADDRESSES.entryPoint07, context: { policyId: "nope" }, sender: account.address, nonce: 0n, callData: "0x" }); log("3_bad_policy", { rejected: false }); }
catch (e) { log("3_bad_policy", { rejected: true, reason: e.details ?? e.shortMessage ?? e.message?.slice(0, 120), data: e.cause?.data ?? e.data }); }

console.log("\nRESULT:", uo.paymaster?.toLowerCase() === stub.paymaster.toLowerCase() && uo.paymasterVerificationGasLimit > 0n ? "PASS (stub+estimate, nothing reserved)" : "FAIL");
