import type { Chain, Client, Transport } from "viem";

/** A viem client bound to a chain with no account (what `createPublicClient` returns). */
export type ChainClient = Client<Transport, Chain, undefined>;
