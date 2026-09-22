// SDK e2e on HPP Sepolia — the same scenario test/cases/t410 + t46 + t45 prove with raw RPC, now through @hpp-io/aa-sdk.
//
//   RELAYER_KEY=0x… PAYER_KEY=0x… node examples/e2e-sepolia.mjs            # 7702 path (default)
//   RELAYER_KEY=0x… PAYER_KEY=0x… MODE=factory node examples/e2e-sepolia.mjs # existing-wallet path (owner = WalletClient signer)
//   RELAYER_KEY=0x… PAYER_KEY=0x… OWNER=embedded node examples/e2e-sepolia.mjs # 7702 via toEmbeddedOwner (Privy/Dynamic shape)
//
// RELAYER_KEY funds throwaway accounts. Defaults to examples/.sdk-test-sponsor.json (dedicated key, 0x050BC3…).
// ⚠️ Never the executor refill funder (DEPLOYER/FUNDER_KEY) — it trips BundlerFunderBalanceLow (happened 2026-09-07 and 2026-09-21).
// PAYER_KEY holds test USDC.e (0.07 is moved to the user and comes straight back).
// BUNDLER_URL defaults to the local tunnel http://localhost:14337.
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatUnits, custom } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fs from "node:fs";
import { createHppAccount, createHppSessionClient, hppSepolia, TOKENS, ADDRESSES, toEmbeddedOwner } from "../dist/index.js";

const SPONSOR_FILE = new URL("./.sdk-test-sponsor.json", import.meta.url);
const RELAYER_KEY = process.env.RELAYER_KEY ?? (fs.existsSync(SPONSOR_FILE) ? JSON.parse(fs.readFileSync(SPONSOR_FILE)).k : undefined);
if (!RELAYER_KEY) throw new Error("RELAYER_KEY 또는 examples/.sdk-test-sponsor.json 필요 (funder 키 금지)");
const FUNDER = "0xba8a6b555a7a014a3822c962ea0bd778eeb02f11";

const BUNDLER = process.env.BUNDLER_URL ?? "http://localhost:14337";
// 대납 모드: PAYMASTER_URL(eth_*+pm_* 단일 엔드포인트) + POLICY_ID(+ANCHOR_ID). 계정에 ETH를 넣지 않는다 → 시나리오 ① "가스 없는 사용자".
// ⚠️ pm_getPaymasterData 가 정책 예산·앵커 캡을 예약한다. 공유 dev 정책에 돌릴 때는 운영자와 조율.
const SPONSORED = !!process.env.POLICY_ID;
const PM_URL = process.env.PAYMASTER_URL ?? BUNDLER;
const paymaster = SPONSORED ? { url: PM_URL, policyId: process.env.POLICY_ID, ...(process.env.ANCHOR_ID ? { anchorId: process.env.ANCHOR_ID } : {}) } : undefined;
const MODE = process.env.MODE === "factory" ? "factory" : "7702";
const chain = hppSepolia;
const pub = createPublicClient({ chain, transport: http() });
const relayer = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain, transport: http() });
if (relayer.account.address.toLowerCase() === FUNDER) throw new Error("RELAYER_KEY가 executor 리필 funder와 같은 키 — 전용 테스트 키를 쓰세요 (TEST_PLAN §3.2.1)");
const payer = createWalletClient({ account: privateKeyToAccount(process.env.PAYER_KEY), chain, transport: http() });
const USDC = TOKENS[chain.id].USDCe;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const log = (k, v) => console.log(`[${k}]`, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const wait = (h) => pub.waitForTransactionReceipt({ hash: h });
const t0 = Date.now();

// ── owner: 7702 → local key (Privy-like). factory → a WalletClient with a JSON-RPC-style account that can only personal_sign (MetaMask-like)
const ownerKey = privateKeyToAccount(generatePrivateKey());
let owner = ownerKey;
if (process.env.OWNER === "embedded") {
  // Emulate an embedded wallet (Privy/Dynamic): only personal_sign + signAuthorization are exposed, no private key.
  owner = toEmbeddedOwner({ address: ownerKey.address, signMessage: (h) => ownerKey.signMessage({ message: { raw: h } }), signAuthorization: (a) => ownerKey.signAuthorization(a) });
}
if (MODE === "factory") {
  // Emulate a browser wallet: expose only eth_accounts / personal_sign, no signAuthorization.
  const provider = { request: async ({ method, params }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [ownerKey.address];
    if (method === "personal_sign") return ownerKey.signMessage({ message: { raw: params[0] } });
    if (method === "eth_chainId") return "0x" + chain.id.toString(16);
    throw new Error("wallet stub: " + method);
  } };
  owner = createWalletClient({ account: ownerKey.address, chain, transport: custom(provider) });
}
const agent = privateKeyToAccount(generatePrivateKey());

// 1. account object — developer step 1
const user = await createHppAccount({ owner, chain, bundlerUrl: SPONSORED ? PM_URL : BUNDLER, paymaster });
log("1_account", { owner: process.env.OWNER ?? (MODE === "factory" ? "walletclient" : "localkey"), mode: user.mode, address: user.address, sameAsOwner: user.address.toLowerCase() === ownerKey.address.toLowerCase() });

// funding (no paymaster yet → the account pays its own gas; 7702: the EOA itself, factory: the counterfactual address)
// ~4 UserOps × ~3.8M gas × 0.019 gwei ≈ 0.0003 ETH; 0.003 leaves 10× margin.
if (!SPONSORED) await wait(await relayer.sendTransaction({ to: user.address, value: 3_000_000_000_000_000n }));
else log("0_sponsored", { policy: paymaster.policyId, anchor: paymaster.anchorId ?? null, accountEth: (await pub.getBalance({ address: user.address })).toString() });
if ((await pub.getBalance({ address: payer.account.address })) < 500_000_000_000_000n)
  await wait(await relayer.sendTransaction({ to: payer.account.address, value: 1_000_000_000_000_000n }));
await wait(await payer.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [user.address, 40_000n] }));
const sink = payer.account.address;
const sinkBefore = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [sink] });

// 2. make the account real: 7702 → type-4 delegation tx; factory → createAccount tx (KernelFactory is not staked,
//    so initCode deployment is rejected by the bundler's ERC-7562 rules). Relayer sponsors the gas either way.
const del = await user.ensureReady({ sponsor: relayer });
log("2_ready", { mode: user.mode, tx: del, ready: await user.isReady() });

// 3. first UserOp: Smart Sessions install is prepended automatically; the call itself is a 0.01 USDC.e transfer
const r3 = await user.sendCalls([{ to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sink, 10_000n] }) }]);
log("3_first_userop", { success: r3.success, tx: r3.txHash, smartSessions: await user.hasSmartSessions() });

// 4. grant the agent a session: USDC.e transfer only, 0.05 cap
const { permissionId } = await user.grantSession({
  signer: agent.address,
  actions: [{ target: USDC, signature: "transfer(address,uint256)" }],
  spend: [{ token: USDC, limit: 50_000n }],
});
log("4_session", { permissionId, enabled: await user.isSessionEnabled(permissionId) });

// 5. agent spends 0.03 twice → 2nd must be rejected (cumulative 0.06 > 0.05), and a non-allowed target must be rejected
const agentClient = await createHppSessionClient({ account: user.address, permissionId, signer: agent, chain, bundlerUrl: SPONSORED ? PM_URL : BUNDLER, paymaster });
const pay = (amt) => agentClient.sendCalls([{ to: USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sink, amt] }) }]);
const tryIt = async (label, fn) => { try { const r = await fn(); log(label, { ok: r.success, tx: r.txHash }); return r.success; } catch (e) { log(label, { ok: false, err: (e.shortMessage ?? e.message).slice(0, 120) }); return false; } };
const s1 = await tryIt("5a_agent_0.03", () => pay(30_000n));
const s2 = await tryIt("5b_agent_0.03_again(over cap)", () => pay(30_000n));
const s3 = await tryIt("5c_agent_other_target", () => agentClient.sendCalls([{ to: ADDRESSES.multicall3, data: "0x42cbb15c" }]));

// 6. revoke → agent rejected even within cap
const rv = await user.revokeSession(permissionId);
const s4 = await tryIt("6_after_revoke_0.01", () => pay(10_000n));
log("6_revoked", { tx: rv.txHash, enabled: await user.isSessionEnabled(permissionId) });

const got = (await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [sink] })) - sinkBefore;
const expected = 10_000n + 30_000n; // step 3 + one agent spend (payer 소모 0: 0.04 지급 → 전액 복귀)
console.log("\n=== SDK e2e 판정 (" + MODE + (process.env.OWNER ? "/" + process.env.OWNER : "") + (SPONSORED ? "/sponsored" : "") + ") ===");
if (SPONSORED) console.log("계정 ETH 잔고(끝)     :", (await pub.getBalance({ address: user.address })).toString(), "wei — 0이어야 대납 성립");
console.log("owner UserOp 성공     :", r3.success ? "PASS" : "FAIL");
console.log("세션 내 지출 성공     :", s1 ? "PASS" : "FAIL");
console.log("한도 초과 거부        :", !s2 ? "PASS" : "FAIL");
console.log("허용 외 대상 거부     :", !s3 ? "PASS" : "FAIL");
console.log("취소 후 거부          :", !s4 ? "PASS" : "FAIL");
console.log("실지출 일치           :", got === expected ? "PASS" : `FAIL(${formatUnits(got, 6)} vs ${formatUnits(expected, 6)})`);
console.log(`소요 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log("\nRESULT:", r3.success && s1 && !s2 && !s3 && !s4 && got === expected ? "PASS" : "FAIL");
