import type { Address, Hex } from "viem";

/** Canonical (CREATE2) addresses — identical on every chain where HPP deployed them. */
export const ADDRESSES = {
  entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  entryPoint08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  /** Kernel v3.3 account logic — EIP-7702 delegation target. */
  kernelV33: "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
  /** KernelFactory (impl = kernelV33) — counterfactual accounts for owners that cannot sign 7702. */
  kernelFactory: "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9",
  /** ZeroDev ECDSAValidator — root validator for factory accounts. */
  kernelEcdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57",
  smartSessions: "0x00000000008bDABA73cD9815d79069c247Eb4bDA",
  ownableValidator: "0x000000000013fdB5234E4E3162a810F54d9f7E98",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

/** Per-chain token addresses. */
export const TOKENS: Record<number, { USDCe: Address }> = {
  181228: { USDCe: "0x401eCb1D350407f13ba348573E5630B83638E30D" },
};

/**
 * ERC-7710 delegation contracts (MetaMask delegation-framework v1.3.0, redeployed by HPP,
 * CREATE2 salt `hpp-x402-7710-poc`). Agents pay x402 from the user's account under these caveats;
 * the HPP facilitator accepts only this DelegationManager and this enforcer set.
 * Sepolia = PoC deployment (owner = deployer EOA); mainnet lands with a multisig owner.
 */
export const ERC7710: Record<number, { delegationManager: Address; enforcers: Record<
  "ERC20TransferAmountEnforcer" | "ERC20PeriodTransferEnforcer" | "RedeemerEnforcer" | "AllowedCalldataEnforcer" | "TimestampEnforcer" | "LimitedCallsEnforcer", Address> }> = {
  181228: {
    delegationManager: "0x20248e5193B1Ef08298812AdA31F4B0D75e99652",
    enforcers: {
      ERC20TransferAmountEnforcer: "0x8b76d04EbB53082D258e653ddb49423ce142c546",
      ERC20PeriodTransferEnforcer: "0x70d21Cd7DA2238536f5b1041e3c99B6C018242cb",
      RedeemerEnforcer: "0x7914D7940E7b6A2F8579FaB1c4c02CB4370700f8",
      AllowedCalldataEnforcer: "0x31c407faAFbc69868b4d8822B1a761214A04080b",
      TimestampEnforcer: "0xa5FB0F520984Ece260b9248D4Ae6A2f6350a4850",
      LimitedCallsEnforcer: "0x5392D307606FD66a756FD0dA4B5BCa39C0AB4Dfe",
    },
  },
};
/** Chains where the AA stack (EntryPoint v0.7, Kernel, Smart Sessions) is live. */
export const AA_LIVE_CHAINS: readonly number[] = [181228];

/** `execute(bytes32,bytes)` — the only selector Smart Sessions is allowed to call on Kernel. */
export const KERNEL_EXECUTE_SELECTOR: Hex = "0xe9ae5c53";
