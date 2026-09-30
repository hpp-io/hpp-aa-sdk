// x402 payment by an AGENT that holds no funds: the user's Kernel account signs an ERC-7710
// payment delegation (on-chain caps), the agent redelegates per payment, the HPP facilitator
// redeems it. No UserOp per payment; the facilitator pays gas.
//
//   PAYER_KEY=0x…  node examples/x402-erc7710.mjs              # PAYER_KEY = owner EOA of a 7702 Kernel account
//   FACILITATOR_URL=http://127.0.0.1:4029  AMOUNT=10000  PAY_TO=0x…  (defaults below)
//
// Wallet side needs the DelegationManager executor installed once (one sponsored UserOp) — pass
// BUNDLER_URL (+ PAYMASTER_URL/POLICY_ID/ANCHOR_ID for sponsorship) if this account has not done it yet.
import { readFileSync } from "node:fs";
import { createPublicClient, http, formatUnits, getAddress, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createHppAccount, hppSepolia, TOKENS, buildPaymentRedelegation, signPaymentRedelegation } from "../dist/index.js";

const chain = hppSepolia;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:4029";
const PAY_TO = getAddress(process.env.PAY_TO ?? "0x9Dc2A176Ca65D982854CDe9BE84Dc7028236ba2c");
const AMOUNT = BigInt(process.env.AMOUNT ?? "10000"); // 0.01 USDC.e
const USDC = TOKENS[chain.id].USDCe;
const payerKey = process.env.PAYER_KEY ?? JSON.parse(readFileSync(new URL("../../hpp-wallet/.agent-test.json", import.meta.url), "utf8")).k;
const owner = privateKeyToAccount(payerKey);
const agent = privateKeyToAccount(generatePrivateKey()); // the agent's key: never funded
const pub = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = async (a) => formatUnits(await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] }), 6);
const post = async (path, body) => { const r = await fetch(`${FACILITATOR_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

// ---------- wallet side ----------
const user = await createHppAccount({ owner, chain, bundlerUrl: process.env.BUNDLER_URL ?? "http://localhost:14337",
  ...(process.env.PAYMASTER_URL ? { paymaster: { url: process.env.PAYMASTER_URL, policyId: process.env.POLICY_ID, anchorId: process.env.ANCHOR_ID } } : {}) });
console.log("user account", user.address, "mode", user.mode, "ready", await user.isReady(), "executor installed", await user.hasDelegationExecutor());

const grant = await user.grantPaymentDelegation({ agent: agent.address, token: USDC, limit: AMOUNT * 5n, validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600) });
console.log("① grant: cap", formatUnits(AMOUNT * 5n, 6), "USDC.e / 1h → agent", agent.address, grant.install ? `(executor installed in ${grant.install.txHash})` : "(no UserOp — signature only)");
// hand `grant.permissionContext` to the agent (config value); keep `grant.delegation` to revoke.

// ---------- agent side (per payment) ----------
const supported = await (await fetch(`${FACILITATOR_URL}/supported`)).json();
const exact = supported.kinds.find((k) => k.scheme === "exact" && k.network === `eip155:${chain.id}`);
const facilitatorAddresses = (exact?.extra?.facilitatorAddresses ?? []).map((a) => getAddress(a)); // a seller's 402 carries the same list
const requirements = { scheme: "exact", network: `eip155:${chain.id}`, amount: AMOUNT.toString(), asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "erc7710", name: "USDC.e", version: "2" } };
const leaf = buildPaymentRedelegation(chain.id, agent.address, { parentPermissionContext: grant.permissionContext, facilitatorAddresses, token: USDC, amount: AMOUNT, payTo: PAY_TO });
const payload = await signPaymentRedelegation({ chainId: chain.id, agent, leaf, parentPermissionContext: grant.permissionContext });
const paymentPayload = { x402Version: 2, resource: { url: `${FACILITATOR_URL}/example`, description: "erc7710 example", mimeType: "application/json" }, accepted: requirements, payload };

const before = { user: await bal(user.address), payTo: await bal(PAY_TO), agent: await bal(agent.address) };
const v = await post("/verify", { paymentPayload, paymentRequirements: requirements });
console.log("② /verify", v.status, JSON.stringify(v.json));
if (!v.json.isValid) process.exit(1);
const s = await post("/settle", { paymentPayload, paymentRequirements: requirements });
console.log("③ /settle", s.status, JSON.stringify(s.json));
const after = { user: await bal(user.address), payTo: await bal(PAY_TO), agent: await bal(agent.address) };
console.log("   USDC.e user", before.user, "→", after.user, "| payTo", before.payTo, "→", after.payTo, "| agent", before.agent, "→", after.agent, "(agent never holds funds)");

// ---------- wallet side: revoke ----------
if (process.env.REVOKE === "1") {
  const r = await user.revokePaymentDelegation(grant.delegation);
  console.log("④ revoke", r.success, r.txHash, "revoked =", await user.isPaymentDelegationRevoked(grant.delegation));
  const again = await post("/verify", { paymentPayload: { ...paymentPayload, payload: await signPaymentRedelegation({ chainId: chain.id, agent, leaf: buildPaymentRedelegation(chain.id, agent.address, { parentPermissionContext: grant.permissionContext, facilitatorAddresses, token: USDC, amount: AMOUNT, payTo: PAY_TO }), parentPermissionContext: grant.permissionContext }) }, paymentRequirements: requirements });
  console.log("   /verify after revoke →", again.json.isValid, again.json.invalidMessage);
}
