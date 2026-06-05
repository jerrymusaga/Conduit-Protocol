import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { chainConfig } from "../chain.js";
import { createJob, linkTask, updateJob } from "../jobs.js";
import {
  computeFeeAtoms,
  getCapabilities,
  getFeeData,
  getStatus,
  relayerUrlForChain,
  send7710Transaction,
  type ChainCapabilities,
  type Send7710Params,
} from "./oneshotClient.js";
import type { RelayBackend, RelayResult, RelaySubmitParams } from "./types.js";

/**
 * Mainnet (and testnet) relay backend — the 1Shot Permissionless Relayer.
 *
 * 1Shot submits redeemDelegations and recoups gas in the buyer's stablecoin, so
 * a submission carries TWO delegations merged into one on-chain batch:
 *   - the FEE delegation (buyer-signed, loose) → pays 1Shot's feeCollector
 *   - the WORK delegation (Conduit's X402ReceiptEnforcer-bound) → pays the seller
 * Conduit's intent-binding survives intact: the fee rides a separate loose
 * delegation; the payment stays tight. Status is driven by webhooks (preferred)
 * with getStatus polling as the fallback.
 *
 * The relayer URL is chosen by chain (.dev for Sepolia/Base Sepolia, .com for
 * mainnets) unless ONESHOT_RELAYER_URL overrides it.
 */

const ESTIMATED_GAS = 250_000n; // upper bound: fee transfer + bound work transfer

const relayerUrl =
  config.oneshot.relayerUrl ?? relayerUrlForChain(config.chainId);
const chainIdStr = String(config.chainId);

// Capabilities are fetched lazily and cached (targetAddress = the redeemer the
// dapp must name; feeCollector = where the fee transfer goes).
let capsCache: ChainCapabilities | null = null;
async function caps(): Promise<ChainCapabilities> {
  if (capsCache) return capsCache;
  const all = await getCapabilities(relayerUrl, [chainIdStr]);
  const c = all[chainIdStr];
  if (!c) throw new Error(`1Shot relayer has no capabilities for chain ${chainIdStr}`);
  capsCache = c;
  return c;
}

// redeemer is resolved asynchronously; we expose the last-known value and warm
// it at startup. The dapp also reads it fresh from /supported.
let cachedRedeemer: Address | null = null;
void caps()
  .then((c) => {
    cachedRedeemer = c.targetAddress;
    console.log(`  oneshot targetAddress (redeemer): ${c.targetAddress}`);
    console.log(`  oneshot feeCollector:             ${c.feeCollector}`);
  })
  .catch((e) => console.warn(`[oneshot-pl] capabilities warm-up failed: ${e}`));

export const oneshotPermissionlessBackend: RelayBackend = {
  name: "oneshot-pl",

  get redeemer(): Address | null {
    return cachedRedeemer;
  },

  get feeCollector(): Address | null {
    return capsCache?.feeCollector ?? null;
  },

  // Awaited by /supported so redeemer + feeCollector are never null due to the
  // async warm-up race.
  async ensureReady(): Promise<void> {
    const c = await caps();
    cachedRedeemer = c.targetAddress;
  },

  // Live gas-fee estimate (USDC atoms) so the buyer sizes the bounded fee
  // delegation to the real quote, not a hardcoded ceiling. Same computation
  // submit() uses; the buyer adds a safety buffer on top.
  async estimateFeeAtoms(): Promise<bigint | null> {
    try {
      const fee = await getFeeData(relayerUrl, chainIdStr, chainConfig.usdc);
      return computeFeeAtoms(fee, ESTIMATED_GAS);
    } catch {
      return null;
    }
  },

  async submit(params: RelaySubmitParams): Promise<RelayResult> {
    const job = createJob();

    const o = params.oneshot;
    if (!o) {
      const error =
        "oneshot-pl requires the structured `oneshot` payload (workDelegation, " +
        "feeDelegation, workExecution) — the buyer must sign a fee delegation.";
      updateJob(job.id, { status: "failed", error });
      return { jobId: job.id, status: "failed", error };
    }

    try {
      const chainCaps = await caps();

      // 1) Live fee quote (signed price-lock context). Floor at minFee.
      const fee = await getFeeData(relayerUrl, chainIdStr, o.paymentToken);
      const feeAtoms = computeFeeAtoms(fee, ESTIMATED_GAS);
      const feeCollector = (fee.feeCollector ?? chainCaps.feeCollector) as Address;

      // 2) Build the fee execution from the live quote (always matches the
      //    relayer's required amount; the buyer's fee delegation caps it).
      const feeExecution = {
        target: o.paymentToken,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [feeCollector, feeAtoms],
        }) as Hex,
      };

      // 3) Submit: two delegations (fee + work), each its own transactions[]
      //    entry; the relayer merges them into one redeemDelegations batch.
      const submitParams: Send7710Params = {
        chainId: chainIdStr,
        context: fee.context,
        // Point 1Shot at OUR inbound webhook so its Ed25519-signed status events
        // drive the job (the bonus-scored path). Poll remains the fallback.
        ...(config.oneshot.webhookUrl
          ? { destinationUrl: config.oneshot.webhookUrl }
          : {}),
        ...(params.authorization
          ? {
              authorizationList: [
                {
                  address: params.authorization.address,
                  chainId: params.authorization.chainId,
                  nonce: params.authorization.nonce,
                  r: params.authorization.r,
                  s: params.authorization.s,
                  yParity: params.authorization.yParity,
                },
              ],
            }
          : {}),
        transactions: [
          { permissionContext: o.feeChain, executions: [feeExecution] },
          { permissionContext: o.workChain, executions: [o.workExecution] },
        ],
      };

      const taskId = await send7710Transaction(relayerUrl, submitParams);
      linkTask(taskId, job.id); // so inbound 1Shot webhooks resolve this job
      updateJob(job.id, { status: "pending" });

      // 4) Drive the job to terminal state. 1Shot's signed webhooks are the
      //    preferred source (POST /relayer-webhook); poll is the always-on
      //    fallback when no public webhook URL is configured.
      void pollOneshot(job.id, taskId);

      return { jobId: job.id, status: "pending" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      updateJob(job.id, { status: "failed", error });
      return { jobId: job.id, status: "failed", error };
    }
  },
};

async function pollOneshot(jobId: string, taskId: Hex): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let s;
    try {
      s = await getStatus(relayerUrl, taskId, false);
    } catch {
      continue; // transient; keep polling
    }
    if (s.status === 110 && s.hash) updateJob(jobId, { txHash: s.hash });
    if (s.status === 200) {
      updateJob(jobId, { status: "confirmed", txHash: s.receipt?.transactionHash ?? s.hash });
      return;
    }
    if (s.status === 400) {
      updateJob(jobId, { status: "failed", error: s.message ?? "rejected" });
      return;
    }
    if (s.status === 500) {
      updateJob(jobId, { status: "failed", error: `reverted ${JSON.stringify(s.data ?? "")}` });
      return;
    }
  }
  updateJob(jobId, { status: "failed", error: "1Shot task timed out" });
}
