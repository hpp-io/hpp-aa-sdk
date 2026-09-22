// Read-only dry run against the live bundler: factory-mode account, prepare (estimate) a first UserOp with SS install + 1 call.
import { createPublicClient, http, custom, createWalletClient, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createHppAccount, hppSepolia, ADDRESSES, installSmartSessionsCall } from "../dist/index.js";
const chain = hppSepolia;
const ownerKey = privateKeyToAccount(generatePrivateKey());
const provider = { request: async ({ method, params }) => {
  if (method === "eth_accounts" || method === "eth_requestAccounts") return [ownerKey.address];
  if (method === "personal_sign") return ownerKey.signMessage({ message: { raw: params[0] } });
  if (method === "eth_chainId") return "0x" + chain.id.toString(16);
  throw new Error("wallet stub: " + method);
} };
const owner = createWalletClient({ account: ownerKey.address, chain, transport: custom(provider) });
const user = await createHppAccount({ owner, chain, bundlerUrl: process.env.BUNDLER_URL ?? "http://localhost:14337" });
console.log("mode", user.mode, "address", user.address, "ready", await user.isReady(), "ss", await user.hasSmartSessions());
const fa = await user.account.getFactoryArgs();
console.log("factory", fa.factory, "factoryData bytes", (fa.factoryData.length - 2) / 2);
console.log("nonce", await user.account.getNonce());
const calls = [installSmartSessionsCall(user.address), { to: ADDRESSES.multicall3, data: "0x42cbb15c" }];
try {
  const uo = await user.bundler.prepareUserOperation({ account: user.account, calls });
  console.log("ESTIMATE OK", { callGasLimit: uo.callGasLimit, verificationGasLimit: uo.verificationGasLimit, preVerificationGas: uo.preVerificationGas, maxFeePerGas: uo.maxFeePerGas, maxPriorityFeePerGas: uo.maxPriorityFeePerGas, factory: uo.factory });
} catch (e) { console.log("ESTIMATE ERR", (e.shortMessage ?? e.message).slice(0, 300), "\n", (e.details ?? "").slice(0, 300)); }
// 7702 mode: same estimate on an undelegated fresh EOA must fail clearly (guard check)
const u2 = await createHppAccount({ owner: ownerKey, chain, bundlerUrl: process.env.BUNDLER_URL ?? "http://localhost:14337" });
console.log("7702 mode", u2.mode, "ready", await u2.isReady());
try { await u2.sendCalls([{ to: ADDRESSES.multicall3, data: "0x42cbb15c" }]); } catch (e) { console.log("7702 guard:", e.message.slice(0, 100)); }
