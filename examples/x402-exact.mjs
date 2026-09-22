// ERC-1271 x402 결제: 7702 계정과 factory 계정 둘 다 실제 판매자에게 결제한다.
// usage: MODE=7702|factory node examples/x402-exact.mjs
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createHppAccount, hppSepolia } from "../dist/index.js";

const MODE = process.env.MODE === "factory" ? "factory" : "7702";
const URL_ = process.env.URL ?? "https://agent-sepolia.hpp.io/paid/compute/hello-world";
const RPC = process.env.RPC_URL ?? "https://sepolia-node1.hpp.io";
const BUNDLER = process.env.BUNDLER_URL ?? "http://127.0.0.1:24399/rpc";
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const b64 = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const relayer = createWalletClient({ account: privateKeyToAccount(JSON.parse(fs.readFileSync(new URL("./.sdk-test-sponsor.json", import.meta.url))).k), chain: hppSepolia, transport: http(RPC) });
const funder = process.env.FUNDER_KEY ? createWalletClient({ account: privateKeyToAccount(process.env.FUNDER_KEY), chain: hppSepolia, transport: http(RPC) }) : null;
const pub = createPublicClient({ chain: hppSepolia, transport: http(RPC) });

const owner = privateKeyToAccount(process.env.OWNER_KEY ?? generatePrivateKey());
const user = await createHppAccount({ owner, chain: hppSepolia, bundlerUrl: BUNDLER, rpcUrl: RPC, mode: MODE });
console.log(`mode=${user.mode} owner=${owner.address} account=${user.address}`);
const ready = await user.ensureReady({ sponsor: relayer });
console.log("ensureReady tx:", ready ?? "(already ready)");

let bal = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [user.address] });
if (bal < 1000n && funder) {
  const h = await funder.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [user.address, 2000n] });
  await pub.waitForTransactionReceipt({ hash: h }); bal = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [user.address] });
}
console.log("account USDC.e", formatUnits(bal, 6), "ETH", formatUnits(await pub.getBalance({ address: user.address }), 18));

const r0 = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const required = b64(r0.headers.get("payment-required"));
const accept = required.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${hppSepolia.id}`);
const http_ = new x402HTTPClient(new x402Client().register(accept.network, new ExactEvmScheme(user.account)));
const payload = await http_.createPaymentPayload({ ...required, accepts: [accept] });
const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", ...http_.encodePaymentSignatureHeader(payload) }, body: JSON.stringify({ input: `x402 from a ${MODE} account` }) });
const text = await res.text();
const settle = res.headers.get("payment-response") ? b64(res.headers.get("payment-response")) : null;
console.log("HTTP", res.status, "|", text.slice(0, 90));
console.log("settle:", settle?.success, "tx", settle?.transaction, "payer", settle?.payer);
if (!res.ok) process.exitCode = 1;
