import { defineChain } from "viem";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** HPP Sepolia (Arbitrum Orbit, ArbOS 51 — EIP-7702 active). */
export const hppSepolia = defineChain({
  id: 181228,
  name: "HPP Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-node1.hpp.io"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

/** HPP Mainnet. AA contracts are NOT deployed here yet (2026-09). */
export const hppMainnet = defineChain({
  id: 190415,
  name: "HPP Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet-node1.hpp.io"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export type HppChain = typeof hppSepolia | typeof hppMainnet;
