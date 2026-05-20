import { config } from "../config.js";
import { oneshotPermissionlessBackend } from "./oneshotPermissionless.js";
import type { RelayBackend } from "./types.js";
import { viemDirectBackend } from "./viemDirect.js";

/**
 * Selects the active relay backend from config. This is the single switch
 * that flips the facilitator between testnet (viem-direct) and mainnet
 * (1Shot Permissionless Relayer).
 */
export function selectRelayBackend(): RelayBackend {
  switch (config.relayBackend) {
    case "viem-direct":
      return viemDirectBackend;
    case "oneshot-pl":
      return oneshotPermissionlessBackend;
  }
}

export type { RelayBackend, RelaySubmitParams, RelayResult } from "./types.js";
