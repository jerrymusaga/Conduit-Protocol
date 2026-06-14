import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { chainConfig } from "../chain.js";
import { createJob, getJob, linkTask, pendingTasks, updateJob } from "../jobs.js";
import {
  computeFeeAtoms,
  estimate7710Transaction,
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

    // Normalize to a list of work legs. The atomic-commission path supplies
    // `works` (N legs → one redeemDelegations batch); the looped path supplies a
    // single workChain/workExecution. One fee leg covers the whole batch.
    const works =
      o.works ??
      (o.workChain && o.workExecution
        ? [{ chain: o.workChain, execution: o.workExecution }]
        : []);
    if (works.length === 0) {
      const error = "oneshot-pl: no work legs (need `works` or workChain+workExecution)";
      updateJob(job.id, { status: "failed", error });
      return { jobId: job.id, status: "failed", error };
    }

    try {
      const chainCaps = await caps();

      // Live fee quote — kept for the feeCollector + as the fallback fee/context.
      const fee = await getFeeData(relayerUrl, chainIdStr, o.paymentToken);
      const feeCollector = (fee.feeCollector ?? chainCaps.feeCollector) as Address;
      const n = works.length;

      // Heuristic fallback (only if estimate is unavailable): size for the N+1
      // executions (every work transfer + the fee transfer) with quote→settle
      // headroom. Undercounting is what makes 1Shot reject with "payment does not
      // cover the total price".
      const heuristicFee =
        n === 1
          ? computeFeeAtoms(fee, ESTIMATED_GAS)
          : (computeFeeAtoms(fee, ESTIMATED_GAS * BigInt(n + 1)) * 3n) / 2n;

      const feeExec = (amount: bigint) => ({
        target: o.paymentToken,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [feeCollector, amount],
        }) as Hex,
      });
      const workTxs = works.map((w) => ({ permissionContext: w.chain, executions: [w.execution] }));
      // Point 1Shot at OUR inbound webhook so its Ed25519-signed status events
      // drive the job (the bonus-scored path). Poll remains the fallback.
      const authorizationList = params.authorization
        ? [
            {
              address: params.authorization.address,
              chainId: params.authorization.chainId,
              nonce: params.authorization.nonce,
              r: params.authorization.r,
              s: params.authorization.s,
              yParity: params.authorization.yParity,
            },
          ]
        : undefined;

      // Prefer the EXACT batch fee from relayer_estimate7710Transaction — it
      // SIMULATES the whole batch and returns the precise required fee + a signed
      // context, so the buyer pays the exact amount (no over-provisioning, no
      // "payment does not cover the total price"). Falls back to the heuristic +
      // getFeeData context if estimate is unavailable. The buyer's fee delegation
      // caps the amount either way, so the exact value is always within the cap.
      let feeAtoms = heuristicFee;
      let context = fee.context;
      try {
        const est = await estimate7710Transaction(relayerUrl, {
          chainId: chainIdStr,
          transactions: [{ permissionContext: o.feeChain, executions: [feeExec(heuristicFee)] }, ...workTxs],
          ...(authorizationList ? { authorizationList } : {}),
        });
        if (est.success && est.requiredPaymentAmount) {
          feeAtoms = BigInt(est.requiredPaymentAmount);
          if (est.context) context = est.context;
          console.log(`[oneshot] exact fee via estimate7710Transaction: ${feeAtoms} atoms (${n} leg${n === 1 ? "" : "s"})`);
        } else {
          console.warn(`[oneshot] estimate returned no fee (${est.error ?? "unknown"}); using heuristic ${heuristicFee}`);
        }
      } catch (e) {
        console.warn(
          `[oneshot] estimate7710Transaction unavailable (${e instanceof Error ? e.message : e}); using heuristic ${heuristicFee}`
        );
      }

      // ONE batch: the shared fee leg first (exact fee), then every intent-bound
      // work leg. 1Shot merges these into a single redeemDelegations — so the
      // budget enforcer accumulates across the legs and the whole batch is
      // all-or-nothing (verified: test/AtomicBatchBudget.fork.t.sol).
      const submitParams: Send7710Params = {
        chainId: chainIdStr,
        ...(context ? { context } : {}),
        ...(config.oneshot.webhookUrl ? { destinationUrl: config.oneshot.webhookUrl } : {}),
        ...(authorizationList ? { authorizationList } : {}),
        transactions: [{ permissionContext: o.feeChain, executions: [feeExec(feeAtoms)] }, ...workTxs],
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
      // Don't overwrite the webhook's attribution if it confirmed first — the
      // signed webhook is the bonus path we want to surface.
      const alreadyVia = getJob(jobId)?.confirmedVia;
      updateJob(jobId, {
        status: "confirmed",
        txHash: s.receipt?.transactionHash ?? s.hash,
        ...(alreadyVia ? {} : { confirmedVia: "poll" }),
      });
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
  // Poll gave up. If a webhook is configured it stays the source of truth — do
  // NOT mark failed (that would wrongly notify "failed" for a job that may still
  // confirm via the signed webhook). Without a webhook, poll is the only path.
  if (config.oneshot.webhookUrl) {
    console.warn(`[oneshot] poll window elapsed for job ${jobId.slice(0, 8)} — leaving terminal state to the webhook`);
  } else {
    updateJob(jobId, { status: "failed", error: "1Shot task timed out" });
  }
}

// On boot, resume polling for any jobs that were still in-flight when the
// process last stopped (persisted in the jobs store) — so a restart
// mid-settlement still drives them to a terminal state. Webhooks + this poll.
for (const { taskId, jobId } of pendingTasks()) {
  console.log(`[oneshot] resuming poll for job ${jobId.slice(0, 8)} (task ${taskId.slice(0, 12)}…)`);
  void pollOneshot(jobId, taskId as Hex);
}
