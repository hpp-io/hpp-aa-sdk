// 대납 경로 "예약 없이" 검증: 7702 Kernel 계정(ETH 0)으로 pm_getPaymasterStubData + eth_estimateUserOperationGas 까지만.
// 예산·앵커 캡을 소모하는 pm_getPaymasterData / 전송은 하지 않는다 (다른 세션의 dev 정책 DB에 영향 없음).
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

// 이미 Kernel로 위임된 계정이 있으면 재사용 (없으면 위임 전 EOA — 검증 단계에서 code 필요하므로 위임된 계정이 필요)
const known = process.env.DELEGATED_ACCOUNT_KEY ? privateKeyToAccount(process.env.DELEGATED_ACCOUNT_KEY) : null;
const owner = known ?? privateKeyToAccount(generatePrivateKey());
const account = await toKernelAccount({ client, owner, mode: "7702" });
const code = (await client.getCode({ address: account.address })) ?? "0x";
log("0_account", { address: account.address, delegated: code.toLowerCase() === kernelDelegationCode(), eth: (await client.getBalance({ address: account.address })).toString() });
if (code.toLowerCase() !== kernelDelegationCode()) { console.log("위임된 Kernel 계정이 필요합니다 (DELEGATED_ACCOUNT_KEY). 종료."); process.exit(2); }

const bundler = createHppBundlerClient({ chain, bundlerUrl: PM, client, account, ...resolvePaymasterOption({ url: PM, ...ctx }) });
const pm = createPaymasterClient({ transport: http(PM) });
const mc = parseAbi(["function getBlockNumber() view returns (uint256)"]);
const calls = [{ to: ADDRESSES.multicall3, data: encodeFunctionData({ abi: mc, functionName: "getBlockNumber" }) }];

// 1) stub: viem이 pm_getPaymasterStubData(userOp, EP, chainId, context) 호출 → paymaster 필드 채움 (예약 없음)
const stub = await pm.getPaymasterStubData({ chainId: chain.id, entryPointAddress: ADDRESSES.entryPoint07, context: ctx, sender: account.address, nonce: 0n, callData: "0x" });
log("1_stub", { paymaster: stub.paymaster, isFinal: stub.isFinal, pmVerificationGas: stub.paymasterVerificationGasLimit, pmPostOpGas: stub.paymasterPostOpGasLimit, dataBytes: (stub.paymasterData.length - 2) / 2 });

// 2) prepare: stub → estimate 까지 (pm_getPaymasterData는 sendUserOperation 시점에만 호출되므로 여기서는 예약이 발생하지 않음)
const uo = await bundler.prepareUserOperation({ account, calls, parameters: ["factory", "fees", "gas", "nonce", "paymaster", "signature"] });
log("2_prepared", { paymaster: uo.paymaster, callGas: uo.callGasLimit, verGas: uo.verificationGasLimit, pVG: uo.preVerificationGas, pmVerGas: uo.paymasterVerificationGasLimit, maxFee: uo.maxFeePerGas });

// 3) 거절 케이스도 예약 없이: 없는 정책 → stub 단계에서 policy_not_found 가 오는지
try { await pm.getPaymasterStubData({ chainId: chain.id, entryPointAddress: ADDRESSES.entryPoint07, context: { policyId: "nope" }, sender: account.address, nonce: 0n, callData: "0x" }); log("3_bad_policy", { rejected: false }); }
catch (e) { log("3_bad_policy", { rejected: true, reason: e.details ?? e.shortMessage ?? e.message?.slice(0, 120), data: e.cause?.data ?? e.data }); }

console.log("\nRESULT:", uo.paymaster?.toLowerCase() === stub.paymaster.toLowerCase() && uo.paymasterVerificationGasLimit > 0n ? "PASS (stub+estimate, 예약 0)" : "FAIL");
