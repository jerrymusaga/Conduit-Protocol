import { config } from "../config.js";
import { createJob, updateJob } from "../jobs.js";
import type { RelayBackend, RelayResult, RelaySubmitParams } from "./types.js";

/**
 * Mainnet relay backend — 1Shot Permissionless Relayer.
 *
 * STATUS: stub. Fill in around days 19-20 of the build, when switching the
 * final demo to Base mainnet. The interface matches viemDirect exactly, so
 * flipping RELAY_BACKEND=oneshot-pl is the only change routes/settle needs.
 *
 * What it will do:
 *   1. POST a JSON-RPC request to config.oneshot.relayerUrl
 *      (https://relayer.1shotapi.com/relayers). The relayer submits the
 *      redeemDelegations tx — including the buyer's EIP-7702 authorization —
 *      and charges gas in config.oneshot.gasToken (USDC by default).
 *   2. Return a job id immediately. 1Shot's relayer webhooks drive the
 *      job to confirmed/failed (the prize criteria reward using their
 *      webhooks as the status source — wire them into webhook.ts).
 *
 * Open questions to resolve when implementing (verify against live docs at
 * https://1shotapi.com/docs/relayer/get-started/first-transaction):
 *   - exact JSON-RPC method name(s) for submitting a 7702 + redeem call
 *   - how the relayer wants the authorization tuple encoded
 *   - how it reports the gas-token charge back to us
 *   - webhook payload shape (to map onto our Job model)
 */
export const oneshotPermissionlessBackend: RelayBackend = {
  name: "oneshot-pl",

  // TBD at the mainnet swap: 1Shot's relayer address (the actual msg.sender
  // at the DM). Buyers will name this in their Redeemer caveat. Pull it from
  // the relayer's capabilities response when implementing this backend.
  redeemer: null,

  async submit(_params: RelaySubmitParams): Promise<RelayResult> {
    const job = createJob();

    // ---- IMPLEMENTATION SKETCH (not yet active) -----------------------
    //
    // const body = {
    //   jsonrpc: "2.0",
    //   id: job.id,
    //   method: "relayer_sendTransaction",   // confirm exact method name
    //   params: [{
    //     chainId: config.chainId,
    //     to: chainConfig.delegationManager,
    //     data: encodeFunctionData({
    //       abi: DM_ABI,
    //       functionName: "redeemDelegations",
    //       args: [_params.permissionContexts, _params.modes, _params.executionCallDatas],
    //     }),
    //     authorizationList: _params.authorization ? [_params.authorization] : [],
    //     gasToken: config.oneshot.gasToken,
    //   }],
    // };
    //
    // const res = await fetch(config.oneshot.relayerUrl!, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify(body),
    // });
    // const json = await res.json();
    // updateJob(job.id, { status: "pending", txHash: json.result?.txHash });
    // // 1Shot webhooks will drive confirmed/failed -> see webhook.ts
    // return { jobId: job.id, status: "pending", txHash: json.result?.txHash };
    //
    // -------------------------------------------------------------------

    const error =
      "oneshot-pl backend not yet implemented — see src/relayers/oneshotPermissionless.ts";
    updateJob(job.id, { status: "failed", error });
    console.warn(
      `[oneshot-pl] submit() called but backend is a stub. Relayer URL: ${config.oneshot.relayerUrl}`
    );
    return { jobId: job.id, status: "failed", error };
  },
};
