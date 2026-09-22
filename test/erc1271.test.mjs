import { test } from "node:test";
import assert from "node:assert/strict";
import { hashMessage, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kernelWrappedHash, signErc1271Hash, signErc1271Message, signErc1271TypedData } from "../dist/erc1271.js";
import { hppSepolia } from "../dist/chains.js";

const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const account = "0x1111111111111111111111111111111111111111";
// eip712Domain() 이 없는(미배포) 계정 → Kernel v3.3 상수 도메인으로 떨어진다
const client = { chain: hppSepolia, request: async () => { throw new Error("no code"); } };

test("wraps the payload hash in the account's Kernel domain", async () => {
  const hash = hashMessage("hello");
  const wrapped = await kernelWrappedHash(client, account, hash);
  assert.equal(wrapped, hashTypedData({
    domain: { name: "Kernel", version: "0.3.3", chainId: hppSepolia.id, verifyingContract: account },
    types: { Kernel: [{ name: "hash", type: "bytes32" }] }, primaryType: "Kernel", message: { hash },
  }));
  assert.notEqual(wrapped, hash);
});

test("signs the wrapped hash as typed data and prefixes the root validator byte", async () => {
  const hash = hashMessage("hello");
  const sig = await signErc1271Hash({ client, account, owner, hash });
  assert.equal(sig.slice(0, 4), "0x00");                       // root validator selector
  assert.equal((sig.length - 2) / 2, 66);                      // 1 + 65 bytes
  const expected = await owner.signTypedData({
    domain: { name: "Kernel", version: "0.3.3", chainId: hppSepolia.id, verifyingContract: account },
    types: { Kernel: [{ name: "hash", type: "bytes32" }] }, primaryType: "Kernel", message: { hash },
  });
  assert.equal(sig, "0x00" + expected.slice(2));
  // EIP-191 로 서명하면 Kernel 이 거부한다 — 그 형태가 아니어야 한다
  assert.notEqual(sig, "0x00" + (await owner.signMessage({ message: { raw: await kernelWrappedHash(client, account, hash) } })).slice(2));
});

test("message and typed-data helpers hash their payload the same way a verifier does", async () => {
  const td = { domain: { name: "Bridged USDC", version: "2", chainId: hppSepolia.id, verifyingContract: "0x401eCb1D350407f13ba348573E5630B83638E30D" }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "value", type: "uint256" }] }, primaryType: "TransferWithAuthorization", message: { from: owner.address, value: 1000n } };
  assert.equal(await signErc1271TypedData({ client, account, owner, typedData: td }), await signErc1271Hash({ client, account, owner, hash: hashTypedData(td) }));
  assert.equal(await signErc1271Message({ client, account, owner, message: "hi" }), await signErc1271Hash({ client, account, owner, hash: hashMessage("hi") }));
});
