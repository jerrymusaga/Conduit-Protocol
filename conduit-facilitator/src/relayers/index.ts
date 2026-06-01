import { oneshotPermissionlessBackend } from "./oneshotPermissionless.js";
import type { RelayBackend } from "./types.js";

/**
 * The active relay backend. Conduit settles through the 1Shot Permissionless
 * Relayer (gas paid in stablecoin). The RelayBackend interface remains a seam
 * so additional backends can be added without touching the routes.
 */
export function selectRelayBackend(): RelayBackend {
  return oneshotPermissionlessBackend;
}

export type { RelayBackend, RelaySubmitParams, RelayResult } from "./types.js";
