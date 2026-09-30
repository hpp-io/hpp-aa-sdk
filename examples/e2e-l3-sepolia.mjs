// SDK e2e — L3 "free, then USDC.e" through the public SDK surface (quoteFee · ensureFeeAllowance · fee on results · session client).
// Self-contained: creates a policy (sponsored_then_token, 1 free op) + anchor via the paymaster admin API, a fresh account per run,
// funds it with USDC.e from PAYER_KEY, and tears the policy down at the end.
// env: PAYMASTER_URL (policy mode, ERC-20 paymaster configured; default http://127.0.0.1:4339/rpc) · ADMIN_TOKEN · PAYER_KEY (USDC.e) · RELAYER_KEY (ETH for setup)
//      MODE=factory for the factory path (default 7702). Bundler must run with MIN_STAKE_VALUE=0.
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createHppAccount, createHppSessionClient, hppSepolia, TOKENS } from "../dist/index.js";

const RPC = process.env.RPC_URL ?? "https://sepolia-node1.hpp.io";
const PM_URL = process.env.PAYMASTER_URL ?? "http://127.0.0.1:4339/rpc";
const ADMIN = PM_URL.replace(/\/rpc$/, "/admin");
const MODE = process.env.MODE === "factory" ? "factory" : "7702";
const USDC = TOKENS[181228].USDCe;
const run = Math.random().toString(36).slice(2, 8), POLICY = `l3-sdk-${run}`, ANCHOR = `anchor-sdk-${run}`;
for (const k of ["ADMIN_TOKEN", "PAYER_KEY", "RELAYER_KEY"]) if (!process.env[k]) { console.log(`RESULT: SKIP (${k} 없음)`); process.exit(0); }

const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const log = (k, v) => console.log(`[${k}]`, typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const checks = []; const check = (name, ok, info) => { checks.push([name, !!ok]); log(ok ? "OK" : "NG", `${name} ${info ?? ""}`); };
const pub = createPublicClient({ chain: hppSepolia, transport: http(RPC) });
const admin = async (method, path, body) => { const r = await fetch(`${ADMIN}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "x-actor": "sdk-e2e" }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${JSON.stringify(j)}`); return j; };
const bal = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });

await admin("POST", "/policies", { id: POLICY, lane: "L3", name: `sdk e2e ${run}`, max_spend_usd_micro: 5000000, max_spend_per_op_usd_micro: 500000, fee_mode: "sponsored_then_token", free_ops_per_anchor: 1, fee_tokens: [{ token: USDC, symbol: "USDC.e", decimals: 6, price_key: "eth_usd", markup_pct: 5, min_fee_micro: 1000 }] });
await admin("POST", `/policies/${POLICY}/activate`, {});
await admin("POST", "/anchors", { id: ANCHOR, kind: "test", policy_ids: [POLICY] });

const relayer = createWalletClient({ account: privateKeyToAccount(process.env.RELAYER_KEY), chain: hppSepolia, transport: http(RPC) });
const payer = createWalletClient({ account: privateKeyToAccount(process.env.PAYER_KEY), chain: hppSepolia, transport: http(RPC) });
const user = await createHppAccount({ owner: privateKeyToAccount(generatePrivateKey()), chain: hppSepolia, bundlerUrl: PM_URL, rpcUrl: RPC, mode: MODE, paymaster: { policyId: POLICY, anchorId: ANCHOR } });
await user.ensureReady({ sponsor: relayer });
await pub.waitForTransactionReceipt({ hash: await payer.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [user.address, 1_000_000n] }) });
log("0_account", { mode: user.mode, address: user.address, usdc: formatUnits(await bal(user.address), 6) });
const transfer1 = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, 1n] }) };

// 1. quote while free → sponsored, and it already names the ERC-20 paymaster + token for the early approve
const q0 = await user.quoteFee([transfer1], { setup: false });
check("quoteFee (free) = sponsored, freeRemaining 1, erc20Paymaster known", q0.mode === "sponsored" && q0.freeRemaining === 1 && !!q0.erc20Paymaster && q0.feeToken?.symbol === "USDC.e", JSON.stringify(q0));

// 2. ensureFeeAllowance folds the approve into the free op (with our own call)
const r1 = await user.ensureFeeAllowance({ calls: [transfer1], setup: false });
const allowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [user.address, q0.erc20Paymaster] });
check("ensureFeeAllowance → one free op: approve + transfer, fee.mode sponsored", r1?.success && r1.fee.mode === "sponsored" && allowance > 10n ** 30n, `tx ${r1?.txHash} fee ${JSON.stringify(r1?.fee)}`);
check("ensureFeeAllowance again → null (already approved, no calls)", (await user.ensureFeeAllowance({ setup: false })) === null);

// 3. quote after free ops → token with maxToken from the gas estimate
const q1 = await user.quoteFee([transfer1], { setup: false });
check("quoteFee (paid) = token with maxToken > 0", q1.mode === "token" && q1.maxToken > 0n && q1.symbol === "USDC.e", q1.mode === "token" ? `maxToken ${formatUnits(q1.maxToken, 6)} rate ${q1.exchangeRate}` : JSON.stringify(q1));

// 4. paid op: fee.charged equals the USDC.e that left the account (minus the 1 unit we transferred) and ≤ maxToken
const b = await bal(user.address);
const r2 = await user.sendCalls([transfer1], { setup: false });
const delta = b - (await bal(user.address)) - 1n;
check("sendCalls (paid): fee.mode token, charged = balance delta ≤ quoted maxToken", r2.success && r2.fee.mode === "token" && r2.fee.charged === delta && delta > 0n && delta <= q1.maxToken, `charged ${formatUnits(delta, 6)} / max ${formatUnits(q1.maxToken, 6)} tx ${r2.txHash}`);

// 5. agent session: grant (paid) then the agent's op is charged to the account's USDC.e
const agent = privateKeyToAccount(generatePrivateKey());
const { permissionId, result: rg } = await user.grantSession({ signer: agent.address, actions: [{ target: USDC, signature: "transfer(address,uint256)" }], spend: [{ token: USDC, limit: 100_000n }], validUntil: Math.floor(Date.now() / 1000) + 3600 });
const agentClient = await createHppSessionClient({ account: user.address, permissionId, signer: agent, chain: hppSepolia, bundlerUrl: PM_URL, rpcUrl: RPC, paymaster: { policyId: POLICY, anchorId: ANCHOR } });
const ra = await agentClient.sendCalls([{ to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, 1000n] }) }]);
check("session grant + agent op both token-charged with fee.charged", rg.success && rg.fee.mode === "token" && ra.success && ra.fee.mode === "token" && ra.fee.charged > 0n, `grant ${formatUnits(rg.fee.charged ?? 0n, 6)} agent ${formatUnits(ra.fee.charged ?? 0n, 6)}`);

// 6. an op that would empty the account is refused before signing, with a machine-readable reason
let reason = null;
try { await user.sendCalls([{ to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, (await bal(user.address)) - 10_000n] }) }], { setup: false }); }
catch (e) { const { paymasterReason } = await import("../dist/index.js"); reason = paymasterReason(e); }
check("draining op refused pre-sign (would_revert)", reason === "would_revert", reason);

await admin("POST", `/policies/${POLICY}/deactivate`, {});
const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
console.log(`\n=== SDK L3 e2e (${MODE}) ${checks.length - failed.length}/${checks.length} ===`);
console.log(failed.length ? `RESULT: FAIL — ${failed.join(" · ")}` : "RESULT: PASS");
