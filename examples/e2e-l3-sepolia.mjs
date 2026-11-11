// SDK e2e — L3 "free, then USDC.e" through the public SDK surface (design 23: fee approve inside the paying op · agent pays its gas
// from the owner's account via feeApproveAction · revoke always free · fee on results).
// Self-contained: creates a policy (sponsored_then_token, 1 free op) + anchor via the paymaster admin API, a fresh account per run,
// funds it with USDC.e from PAYER_KEY, and tears the policy down at the end.
// env: PAYMASTER_URL (policy mode, ERC-20 paymaster configured; default http://127.0.0.1:4339/rpc) · ADMIN_TOKEN · PAYER_KEY (USDC.e) · RELAYER_KEY (ETH for setup)
//      MODE=factory for the factory path (default 7702). Bundler must run with MIN_STAKE_VALUE=0.
//      FEE_TOKEN=HPP → second fee token (HPP 18 decimals, price_key eth_hpp; settings.eth_hpp must exist) requested via paymaster context.feeToken.
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { approveCall, createHppAccount, createHppSessionClient, feeApproveAction, hppSepolia, TOKENS } from "../dist/index.js";

const RPC = process.env.RPC_URL ?? "https://sepolia-node1.hpp.io";
const PM_URL = process.env.PAYMASTER_URL ?? "http://127.0.0.1:4339/rpc";
const ADMIN = PM_URL.replace(/\/rpc$/, "/admin");
const MODE = process.env.MODE === "factory" ? "factory" : "7702";
const USDC = TOKENS[181228].USDCe;
const HPP = "0x8ebCaf48D2D91b8CEcF1668A4519823881Bf8fc3"; // HPP Sepolia L2 (docs getting-started/hpp-contracts)
// perCall / total = the agent's fee-approve caps (feeApproveAction), in the fee token's units
const FEE = process.env.FEE_TOKEN === "HPP"
  ? { token: HPP, symbol: "HPP", decimals: 18, fund: 2n * 10n ** 18n, perCall: 10n ** 18n, total: 2n * 10n ** 18n }
  : { token: USDC, symbol: "USDC.e", decimals: 6, fund: BigInt(process.env.FUND ?? "1000000"), perCall: 300_000n, total: 2_000_000n };
const isUsdcFee = FEE.token === USDC;
const run = Math.random().toString(36).slice(2, 8), POLICY = `l3-sdk-${run}`, ANCHOR = `anchor-sdk-${run}`;
for (const k of ["ADMIN_TOKEN", "PAYER_KEY", "RELAYER_KEY"]) if (!process.env[k]) { console.log(`RESULT: SKIP (${k} not set)`); process.exit(0); }

const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const log = (k, v) => console.log(`[${k}]`, typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const checks = []; const check = (name, ok, info) => { checks.push([name, !!ok]); log(ok ? "OK" : "NG", `${name} ${info ?? ""}`); };
const pub = createPublicClient({ chain: hppSepolia, transport: http(RPC) });
const admin = async (method, path, body) => { const r = await fetch(`${ADMIN}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "x-actor": "sdk-e2e" }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${JSON.stringify(j)}`); return j; };
const bal = (a) => pub.readContract({ address: FEE.token, abi: erc20, functionName: "balanceOf", args: [a] });   // fee-token balance
const fmt = (v) => formatUnits(v, FEE.decimals);

await admin("POST", "/policies", { id: POLICY, lane: "L3", name: `sdk e2e ${run}`, max_spend_usd_micro: 5000000, max_spend_per_op_usd_micro: 500000, fee_mode: "sponsored_then_token", free_ops_per_anchor: 1, fee_tokens: [{ token: USDC, symbol: "USDC.e", decimals: 6, price_key: "eth_usd", markup_pct: 5, min_fee_micro: 1000 }, { token: HPP, symbol: "HPP", decimals: 18, price_key: "eth_hpp", markup_pct: 10, min_fee_micro: 0 }] });
await admin("POST", `/policies/${POLICY}/activate`, {});
await admin("POST", "/anchors", { id: ANCHOR, kind: "test", policy_ids: [POLICY] });

const relayer = createWalletClient({ account: privateKeyToAccount(process.env.RELAYER_KEY), chain: hppSepolia, transport: http(RPC) });
const payer = createWalletClient({ account: privateKeyToAccount(process.env.PAYER_KEY), chain: hppSepolia, transport: http(RPC) });
const pmCtx = { policyId: POLICY, anchorId: ANCHOR, ...(isUsdcFee ? {} : { feeToken: FEE.token }) };
const user = await createHppAccount({ owner: privateKeyToAccount(generatePrivateKey()), chain: hppSepolia, bundlerUrl: PM_URL, rpcUrl: RPC, mode: MODE, paymaster: pmCtx });
await user.ensureReady({ sponsor: relayer });
await pub.waitForTransactionReceipt({ hash: await payer.writeContract({ address: FEE.token, abi: erc20, functionName: "transfer", args: [user.address, FEE.fund] }) });
if (!isUsdcFee) await pub.waitForTransactionReceipt({ hash: await payer.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [user.address, 10_000n] }) }); // USDC.e for the transfer calls
log("0_account", { mode: user.mode, address: user.address, feeToken: FEE.symbol, feeBal: fmt(await bal(user.address)) });
const transfer1 = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, 1n] }) };

const usdcAllowance = (spender) => pub.readContract({ address: FEE.token, abi: erc20, functionName: "allowance", args: [user.address, spender] });
const agent = privateKeyToAccount(generatePrivateKey());
const agentTransfer = { to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, 1000n] }) };
const PER_CALL = FEE.perCall, TOTAL = FEE.total;
const usdcOut = (n) => (isUsdcFee ? n : 0n);   // USDC.e the calls themselves move — part of the balance delta only when USDC.e is also the fee token

// 1. quote while free → sponsored, and it already names the ERC-20 paymaster + token
const q0 = await user.quoteFee([transfer1], { setup: false });
check("quoteFee (free) = sponsored, freeRemaining 1, erc20Paymaster known", q0.mode === "sponsored" && q0.freeRemaining === 1 && !!q0.erc20Paymaster && q0.feeToken?.symbol === FEE.symbol, JSON.stringify(q0));
const PM = q0.erc20Paymaster;

// 2. the free op registers the agent — the session lets it approve only the paymaster, ≤ PER_CALL each, ≤ TOTAL overall. No approve yet.
const { permissionId, result: rg } = await user.grantSession({
  signer: agent.address,
  actions: [{ target: USDC, signature: "transfer(address,uint256)" }, feeApproveAction({ token: FEE.token, paymaster: PM, perCall: PER_CALL, total: TOTAL })],
  spend: [{ token: USDC, limit: 100_000n }], usageLimit: 20n, validUntil: Math.floor(Date.now() / 1000) + 3600,
});
check("grantSession = the free op, sponsored, nothing approved", rg.success && rg.fee.mode === "sponsored" && (await usdcAllowance(PM)) === 0n, `tx ${rg.txHash}`);

// 3. first paid op is the AGENT's: it approves the fee inside its own op, within the session's per-call cap
const agentClient = await createHppSessionClient({ account: user.address, permissionId, signer: agent, chain: hppSepolia, bundlerUrl: PM_URL, rpcUrl: RPC, paymaster: pmCtx });
let b = await bal(user.address);
const ra = await agentClient.sendCalls([agentTransfer]);
let delta = b - (await bal(user.address)) - usdcOut(1000n), left = await usdcAllowance(PM);
check("agent op after free ops: token-charged from the owner's fee token, approve inlined (0 < allowance left < per-call cap)", ra.success && ra.fee.mode === "token" && ra.fee.charged === delta && delta > 0n && left > 0n && left < PER_CALL, `charged ${fmt(delta)} left ${fmt(left)} ${FEE.symbol} tx ${ra.txHash}`);

const su = await user.sessionUsage(permissionId, { feeToken: FEE.token });
check("sessionUsage reads the agent's ops and fee approvals on-chain", su.ops?.used === 1n && su.ops.limit === 20n && su.feeApproved && su.feeApproved.used === left + delta && su.feeApproved.limit === TOTAL, JSON.stringify(su, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

// 4. owner paid op: quote then send; the allowance stays bounded (never unlimited)
const q1 = await user.quoteFee([transfer1], { setup: false });
check("quoteFee (paid) = token with maxToken > 0", q1.mode === "token" && q1.maxToken > 0n && q1.symbol === FEE.symbol, q1.mode === "token" ? `maxToken ${fmt(q1.maxToken)} rate ${q1.exchangeRate}` : JSON.stringify(q1));
b = await bal(user.address);
const r2 = await user.sendCalls([transfer1], { setup: false });
delta = b - (await bal(user.address)) - usdcOut(1n); left = await usdcAllowance(PM);
check("owner op: charged = balance delta ≤ quoted maxToken, allowance ≤ 1.5 × maxToken", r2.success && r2.fee.mode === "token" && r2.fee.charged === delta && delta > 0n && delta <= q1.maxToken && left <= (q1.maxToken * 3n) / 2n, `charged ${fmt(delta)} / max ${fmt(q1.maxToken)} left ${fmt(left)} ${FEE.symbol} tx ${r2.txHash}`);

// 5. the session's approve is pinned: another spender, or more than the per-call cap, is rejected at validation
const rejects = async (calls) => { try { await agentClient.sendCalls(calls); return false; } catch { return true; } };
check("agent cannot approve a different spender", await rejects([approveCall(FEE.token, relayer.account.address, 1n)]));
check("agent cannot approve the paymaster above the per-call cap", await rejects([approveCall(FEE.token, PM, PER_CALL + 1n)]));

// 6. revoke after the free ops are gone is still free, and carries no approve
const before = await usdcAllowance(PM);
b = await bal(user.address);
const rr = await user.revokeSession(permissionId);
check("revokeSession after free ops: sponsored, no fee token moved, allowance untouched", rr.success && rr.fee.mode === "sponsored" && (await bal(user.address)) === b && (await usdcAllowance(PM)) === before && !(await user.isSessionEnabled(permissionId)), `tx ${rr.txHash}`);
check("revoked agent is rejected", await rejects([agentTransfer]));

// 6. an op that would empty the account is refused before signing, with a machine-readable reason
let reason = null;
// drain the fee token (USDC.e or HPP) down to a dust amount
try { await user.sendCalls([{ to: FEE.token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [relayer.account.address, (await bal(user.address)) - 10n ** BigInt(FEE.decimals - 2)] }) }], { setup: false }); }
catch (e) { const { paymasterReason } = await import("../dist/index.js"); reason = paymasterReason(e); }
check("draining op refused pre-sign (fee_balance_insufficient: nothing left to pay the fee after it runs)", reason === "fee_balance_insufficient", reason);

await admin("POST", `/policies/${POLICY}/deactivate`, {});
const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
console.log(`\n=== SDK L3 e2e (${MODE}) ${checks.length - failed.length}/${checks.length} ===`);
console.log(failed.length ? `RESULT: FAIL — ${failed.join(" · ")}` : "RESULT: PASS");
