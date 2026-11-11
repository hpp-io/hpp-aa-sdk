// HPP as the second fee token — live e2e (hpp-bundler#72 stage G on Sepolia, stage H on mainnet with NETWORK=mainnet).
//   One factory account (OWNER_KEY) under a sponsored_then_token policy with 1 free op and fee tokens [USDC.e, HPP]:
//   1. deploy  = the free op (sponsored)
//   2. quote   = setFeeToken(HPP) → quoteFee prints the HPP cap the account must hold
//   3. charge  = ensureFeeAllowance({ token: HPP }) folds the approve into a 1-wei HPP transfer → charged in HPP
//   STEP=address|deploy|quote|charge|all (default all; stops before "charge" when the HPP balance is below the cap).
//   Env: NETWORK (sepolia|mainnet, default sepolia), OWNER_KEY, POLICY (hpp-fee-e2e), ANCHOR (anchor-hpp-fee-e2e), PAYMASTER_URL, RPC_URL.
//   Mainnet uses real HPP: fund the printed account with a few HPP only, and sweep what is left afterwards.
import { createPublicClient, http, encodeFunctionData, parseAbi, formatUnits, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHppAccount, hppMainnet, hppSepolia } from "../dist/index.js";

const NETS = {
  sepolia: { chain: hppSepolia, rpc: "https://sepolia-node1.hpp.io", pm: "https://aa-sepolia.hpp.io/rpc", hpp: "0x8ebCaf48D2D91b8CEcF1668A4519823881Bf8fc3", treasury: "0xba8A6B555A7A014A3822C962ea0Bd778EEb02f11" },
  mainnet: { chain: hppMainnet, rpc: "https://mainnet-node1.hpp.io", pm: "https://aa.hpp.io/rpc", hpp: "0xB48334E7938367bC24Fe1F19000D6f06C622E6c7", treasury: "0x300C3E3f724e28e816704be36aAA88D818768DE3" },
};
const NET = NETS[process.env.NETWORK ?? "sepolia"];
if (!NET) { console.error(`NETWORK must be one of ${Object.keys(NETS).join("|")}`); process.exit(1); }
const RPC = process.env.RPC_URL ?? NET.rpc;
const PM_URL = process.env.PAYMASTER_URL ?? NET.pm;
const POLICY = process.env.POLICY ?? "hpp-fee-e2e", ANCHOR = process.env.ANCHOR ?? "anchor-hpp-fee-e2e";
const HPP = NET.hpp, TREASURY = NET.treasury;
const STEP = process.env.STEP ?? "all";
if (!process.env.OWNER_KEY) { console.log("RESULT: SKIP (OWNER_KEY not set)"); process.exit(0); }

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const pub = createPublicClient({ chain: NET.chain, transport: http(RPC) });
const owner = privateKeyToAccount(process.env.OWNER_KEY);
const user = await createHppAccount({ owner, chain: NET.chain, bundlerUrl: PM_URL, rpcUrl: RPC, mode: "factory", paymaster: { policyId: POLICY, anchorId: ANCHOR } });
const hppBal = () => pub.readContract({ address: HPP, abi: erc20, functionName: "balanceOf", args: [user.address] });
const log = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);
let fails = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!ok) fails++; };

log("account", { network: process.env.NETWORK ?? "sepolia", chainId: NET.chain.id, address: user.address, owner: owner.address, mode: user.mode, policy: POLICY });
if (STEP === "address") process.exit(0);

// 1. deploy (free op)
// factory mode: the first UserOp carries initCode and the policy's free op pays for it (no relayer ETH needed)
const noop = { to: HPP, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [owner.address, 0n] }) };
if (!(await user.isReady())) {
  const r0 = await user.sendCalls([noop], { allowInitCode: true });
  check("deploy via initCode = sponsored free op", r0.success && r0.fee.mode === "sponsored", `tx ${r0.txHash} fee ${JSON.stringify(r0.fee)}`);
} else log("deploy", "already deployed");
if (STEP === "deploy") process.exit(fails ? 1 : 0);

// 2. quote in HPP
const tokens = await user.feeTokens();
check("feeTokens lists USDC.e and HPP", tokens.some((t) => t.symbol === "USDC.e") && tokens.some((t) => t.token.toLowerCase() === HPP.toLowerCase()), tokens.map((t) => t.symbol).join(","));
user.setFeeToken(HPP);
const transfer1 = { to: HPP, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [owner.address, 1n] }) };
const q = await user.quoteFee([transfer1], { setup: false });
check("quoteFee = token mode in HPP", q.mode === "token" && q.symbol === "HPP" && q.decimals === 18, q.mode === "token" ? `rate ${q.exchangeRate} cap ${q.maxToken === null ? "?" : formatUnits(q.maxToken, 18)} HPP` : JSON.stringify(q));
const before = await hppBal();
log("hpp_balance", formatUnits(before, 18));
if (q.mode === "token" && q.maxToken !== null) log("hpp_needed", formatUnits(q.maxToken, 18));
if (STEP === "quote") process.exit(fails ? 1 : 0);
if (q.mode !== "token" || q.maxToken === null || before < q.maxToken) { console.log(`RESULT: WAIT — fund ${user.address} with ≥ ${q.mode === "token" && q.maxToken ? formatUnits(q.maxToken, 18) : "?"} HPP (has ${formatUnits(before, 18)})`); process.exit(2); }

// 3. charge in HPP — approve (for the cap, with headroom) folded in front of the transfer
const r = await user.ensureFeeAllowance({ token: HPP, amount: q.maxToken * 2n, calls: [transfer1] });
check("op mined", !!r && r.success, r ? `tx ${r.txHash}` : "null (nothing sent)");
check("fee charged in HPP", !!r && r.fee.mode === "token" && r.fee.symbol === "HPP" && r.fee.charged !== null && r.fee.charged > 0n, r ? JSON.stringify(r.fee, (_, x) => (typeof x === "bigint" ? x.toString() : x)) : "");
const after = await hppBal();
const charged = r && r.fee.mode === "token" ? r.fee.charged ?? 0n : 0n;
check("balance delta = 1 wei transfer + charged fee", before - after === 1n + charged, `before ${formatUnits(before, 18)} after ${formatUnits(after, 18)} charged ${formatUnits(charged, 18)}`);
check("charged ≤ quoted cap", charged <= q.maxToken, `${formatUnits(charged, 18)} ≤ ${formatUnits(q.maxToken, 18)}`);
if (r) {
  const logs = await pub.getLogs({ address: HPP, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), args: { from: user.address, to: TREASURY }, fromBlock: r.receipt.receipt.blockNumber, toBlock: r.receipt.receipt.blockNumber });
  check("HPP Transfer → treasury in the same block", logs.length === 1 && logs[0].args.value === charged, logs.map((l) => formatUnits(l.args.value, 18)).join(","));
  log("userOpHash", r.userOpHash);
}
console.log(fails ? `RESULT: FAIL (${fails})` : "RESULT: PASS");
process.exit(fails ? 1 : 0);
