import { parseAbi, type Hex } from "viem";
import { chainConfig, publicClient, walletClient } from "../chain.js";
import { createJob, updateJob } from "../jobs.js";
import { fireWebhook } from "../webhook.js";
import type { RelayBackend, RelayResult, RelaySubmitParams } from "./types.js";

/**
 * Testnet relay backend. Submits redeemDelegations directly via a funded
 * EOA wallet client. If an EIP-7702 authorization is supplied, it's
 * bundled into the same transaction so the buyer's EOA is upgraded to a
 * smart account in the act of paying.
 *
 * This is the development backend. The mainnet demo uses oneshot-pl, which
 * presents the same interface but relays through 1Shot so the buyer pays
 * gas in USDC rather than the relayer fronting ETH.
 */

// No return value in v1.3.0 — see the contracts package notes.
const DM_ABI = parseAbi([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

export const viemDirectBackend: RelayBackend = {
  name: "viem-direct",

  async submit(params: RelaySubmitParams): Promise<RelayResult> {
    if (!walletClient || !walletClient.account) {
      return {
        jobId: "",
        status: "failed",
        error: "viem-direct backend selected but no wallet client configured",
      };
    }

    const job = createJob();

    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        account: walletClient.account,
        chain: chainConfig.chain,
        address: chainConfig.delegationManager,
        abi: DM_ABI,
        functionName: "redeemDelegations",
        args: [
          params.permissionContexts,
          params.modes,
          params.executionCallDatas,
        ],
        // Bundle the buyer's EIP-7702 authorization, if present, so the
        // EOA-to-smart-account upgrade rides in the same tx.
        ...(params.authorization
          ? { authorizationList: [params.authorization] }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateJob(job.id, { status: "failed", error: message });
      return { jobId: job.id, status: "failed", error: message };
    }

    updateJob(job.id, { status: "pending", txHash });

    // Wait for the receipt out-of-band so the HTTP response returns fast.
    // Consumers learn the outcome via webhook or GET /jobs/:id.
    void waitForReceipt(job.id, txHash);

    return { jobId: job.id, status: "pending", txHash };
  },
};

async function waitForReceipt(jobId: string, txHash: Hex): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    const status = receipt.status === "success" ? "confirmed" : "failed";
    const job = updateJob(jobId, {
      status,
      ...(status === "failed" ? { error: "transaction reverted" } : {}),
    });
    if (job) await fireWebhook(job);
  } catch (err) {
    const job = updateJob(jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    if (job) await fireWebhook(job);
  }
}
