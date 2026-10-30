import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ADDRESSES, KERNEL_IMPLS, classifyDelegation, ForeignDelegationError, createHppAccount } from "../dist/index.js";

const SWEEPER = "0x000000000000000000000000000000000000dead";
const kernelCode = `0xef0100${ADDRESSES.kernelV33.slice(2).toLowerCase()}`;

test("classifyDelegation: none / kernel (any allowed impl, case-insensitive) / foreign / contract", () => {
  assert.deepEqual(classifyDelegation(undefined), { kind: "none" });
  assert.deepEqual(classifyDelegation("0x"), { kind: "none" });
  assert.deepEqual(classifyDelegation(kernelCode.toUpperCase().replace("0XEF0100", "0xef0100")), { kind: "kernel", impl: ADDRESSES.kernelV33.toLowerCase() });
  assert.deepEqual(classifyDelegation(`0xef0100${SWEEPER.slice(2)}`), { kind: "foreign", target: SWEEPER });
  assert.equal(classifyDelegation("0x6080604052").kind, "contract");
  // allowlist: a legacy impl kept during an upgrade still counts as ours
  const legacy = "0x1111111111111111111111111111111111111111";
  assert.equal(classifyDelegation(`0xef0100${legacy.slice(2)}`).kind, "foreign");
  assert.equal(classifyDelegation(`0xef0100${legacy.slice(2)}`, [...KERNEL_IMPLS, legacy]).kind, "kernel");
});

// A tiny JSON-RPC stub standing in for the chain: only eth_getCode matters here.
function rpcStub(codeByAddress) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const reqs = JSON.parse(body); const arr = Array.isArray(reqs) ? reqs : [reqs];
        const out = arr.map((r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_getCode" ? (codeByAddress[r.params[0].toLowerCase()] ?? "0x") : r.method === "eth_chainId" ? "0x2c3ec" : null }));
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

test("ensureDelegated refuses to re-delegate a foreign-delegated account and reports the target", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const rpc = await rpcStub({ [owner.address.toLowerCase()]: `0xef0100${SWEEPER.slice(2)}` });
  try {
    const acct = await createHppAccount({ owner, bundlerUrl: "http://127.0.0.1:1", rpcUrl: rpc.url });
    assert.equal(acct.mode, "7702");
    assert.deepEqual(await acct.delegationState(), { kind: "foreign", target: SWEEPER });
    assert.equal(await acct.isReady(), false);
    await assert.rejects(acct.ensureDelegated(), (e) => e instanceof ForeignDelegationError && e.account === owner.address && e.target === SWEEPER && /compromised/.test(e.message));
    await assert.rejects(acct.ensureReady(), ForeignDelegationError);
  } finally { rpc.close(); }
});

test("ensureDelegated is a no-op for a Kernel-delegated account", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const rpc = await rpcStub({ [owner.address.toLowerCase()]: kernelCode });
  try {
    const acct = await createHppAccount({ owner, bundlerUrl: "http://127.0.0.1:1", rpcUrl: rpc.url });
    assert.deepEqual(await acct.delegationState(), { kind: "kernel", impl: ADDRESSES.kernelV33.toLowerCase() });
    assert.equal(await acct.isReady(), true);
    assert.equal(await acct.ensureDelegated(), null);
  } finally { rpc.close(); }
});
