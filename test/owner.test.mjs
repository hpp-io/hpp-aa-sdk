import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { toEmbeddedOwner, canSignAuthorization, signHashPrefixed, ownerAddress, ADDRESSES } from "../dist/index.js";

const key = privateKeyToAccount(generatePrivateKey());
const hash = keccak256(toHex("hello"));

test("toEmbeddedOwner: signatures identical to the underlying key; 7702 capability follows signAuthorization", async () => {
  const with7702 = toEmbeddedOwner({
    address: key.address,
    signMessage: (h) => key.signMessage({ message: { raw: h } }),
    signAuthorization: (a) => key.signAuthorization(a),
  });
  assert.equal(ownerAddress(with7702), key.address);
  assert.equal(await signHashPrefixed(with7702, hash), await key.signMessage({ message: { raw: hash } }));
  assert.equal(canSignAuthorization(with7702), true);
  const auth = await with7702.signAuthorization({ contractAddress: ADDRESSES.kernelV33, chainId: 181228, nonce: 0 });
  const ref = await key.signAuthorization({ contractAddress: ADDRESSES.kernelV33, chainId: 181228, nonce: 0 });
  assert.equal(auth.r, ref.r); assert.equal(auth.s, ref.s);

  const without = toEmbeddedOwner({ address: key.address, signMessage: (h) => key.signMessage({ message: { raw: h } }) });
  assert.equal(canSignAuthorization(without), false, "→ factory mode");
});
