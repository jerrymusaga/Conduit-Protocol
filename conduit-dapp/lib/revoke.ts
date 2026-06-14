/**
 * GASLESS revoke. Disabling a root delegation (the kill switch) is normally a
 * direct tx the user sends — `disableDelegation` is gated onlyDeleGator, so it
 * must come from the user's account, which means native gas (ETH).
 *
 * Here we make it gasless the same way payments are: the user signs (off-chain)
 * a tiny delegation letting the relayer EXECUTE `disableDelegation` FROM the
 * user's 7702 smart account, bounded by MetaMask's AllowedTargets (only the
 * DelegationManager) + AllowedMethods (only disableDelegation) enforcers — so
 * the relayer can do nothing else. The relayer's gas is reimbursed by a small
 * USDC fee leg. Net: the user spends a little USDC (which they already have),
 * never ETH.
 */
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import {
  decodeDelegations,
  encodeDelegations,
  hashDelegation,
  encodeExecutionCalldata,
} from "@metamask/smart-accounts-kit/utils";
import { createExecution, signDelegation as signDelegationWithKey } from "@metamask/smart-accounts-kit";
import { encodeFunctionData, encodePacked, keccak256, parseAbi, toFunctionSelector, toHex, type Hex, type WalletClient } from "viem";
import { config } from "./config";
import type { Coordinator } from "./grant";
import { grantBudget, createCoordinatorAccount, revokeRootDelegation } from "./grant";
import { buildBoundChain, feeCapAtoms, type Delegation, type Eip7702Authorization } from "./payment";
import { fetch402, fetchJob, type PaymentRequirements } from "./endpoint";
import { publicClient } from "./chain";
import { settleSwap } from "./trade";

const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}` as Hex;

const DM_ABI = parseAbi([
  "function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)",
]);
const DISABLE_SELECTOR = toFunctionSelector(
  "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
);

const rand32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Build the gasless-revoke payload for the facilitator. Signs two things on the
 * user's wallet (both instant, off-chain): a bounded "may disable my delegations"
 * grant to the coordinator, and a tiny USDC fee budget to reimburse the relayer.
 */
export async function buildGaslessRevoke(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  /** Encoded chain whose ROOT (last element) should be disabled. */
  context: Hex;
  /** A free 402 from the endpoint — carries the redeemer + feeCollector + fee quote. */
  req: PaymentRequirements;
  authorization?: Eip7702Authorization;
  feeBudgetUsdc?: string;
}): Promise<{ paymentPayload: unknown }> {
  const { walletClient, userAddress, coordinator, req, authorization } = params;
  if (!req.redeemer) throw new Error("facilitator advertised no redeemer");
  if (!req.feeCollector) throw new Error("facilitator advertised no feeCollector");
  const redeemer = req.redeemer;

  // The exact root delegation to disable (the kill target).
  const targetChain = decodeDelegations(params.context) as Array<{
    delegate: Hex; delegator: Hex; authority: Hex;
    caveats: { enforcer: Hex; terms: Hex; args: Hex }[]; salt: Hex | bigint; signature: Hex;
  }>;
  const root = targetChain[targetChain.length - 1];
  const delegationArg = {
    delegate: root.delegate, delegator: root.delegator, authority: root.authority,
    caveats: root.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: BigInt(root.salt), signature: root.signature,
  };
  const disableCalldata = encodeFunctionData({ abi: DM_ABI, functionName: "disableDelegation", args: [delegationArg] });

  // 1) The user signs a bounded "the relayer may call DelegationManager.
  //    disableDelegation, and nothing else" delegation to the coordinator.
  const revokeCaveats = [
    { enforcer: config.allowedTargetsEnforcer, terms: encodePacked(["address"], [config.delegationManager]), args: "0x" as Hex },
    { enforcer: config.allowedMethodsEnforcer, terms: encodePacked(["bytes4"], [DISABLE_SELECTOR]), args: "0x" as Hex },
  ];
  const unsignedRoot = {
    delegate: coordinator.address, delegator: userAddress, authority: ROOT_AUTHORITY,
    caveats: revokeCaveats, salt: rand32(),
  };
  const rootSig = await signDelegation(walletClient, {
    delegation: unsignedRoot, delegationManager: config.delegationManager,
    chainId: config.chainId, name: "DelegationManager", version: "1",
  });
  const revokeRoot = { ...unsignedRoot, signature: rootSig } as unknown as Delegation;

  // open leaf: coordinator → relayer under the revoke root.
  const unsignedLeaf: Omit<Delegation, "signature"> = {
    delegate: redeemer, delegator: coordinator.address, authority: hashDelegation(revokeRoot),
    caveats: [], salt: rand32(),
  };
  const leafSig = await signDelegationWithKey({
    privateKey: coordinator.privateKey, delegation: unsignedLeaf,
    delegationManager: config.delegationManager, chainId: config.chainId,
    name: "DelegationManager", version: "1", allowInsecureUnrestrictedDelegation: true,
  });
  const revokeChain: Delegation[] = [{ ...unsignedLeaf, signature: leafSig }, revokeRoot];

  // 2) A tiny USDC fee budget to reimburse the relayer's gas (no ETH).
  const feeGrant = await grantBudget({
    walletClient, userAddress, coordinator,
    amountUsdc: params.feeBudgetUsdc ?? "0.30", periodDuration: 3600,
  });
  const feeChain = await buildBoundChain({
    grant: feeGrant, coordinator, redeemer, token: config.usdc,
    recipient: req.feeCollector, maxAmount: feeCapAtoms(req.feeEstimate), intentHash: keccak256(toHex(rand32())),
  });

  const execution = { target: config.delegationManager, value: "0", data: disableCalldata };
  const paymentPayload = {
    x402Version: 2, scheme: req.scheme, network: req.network,
    payload: {
      delegationManager: config.delegationManager,
      permissionContext: encodeDelegations(revokeChain),
      delegator: userAddress,
      executionCallData: encodeExecutionCalldata([
        createExecution({ target: config.delegationManager, value: 0n, callData: disableCalldata }),
      ]),
      ...(authorization ? { authorization } : {}),
      oneshot: { paymentToken: config.usdc, works: [{ chain: revokeChain, execution }], feeChain },
    },
  };
  return { paymentPayload };
}

/** Settle a gasless revoke through the facilitator (reuses the swap settle path). */
export async function settleGaslessRevoke(
  paymentPayload: unknown,
  meta: { correlationId?: string; agent?: string } = {}
) {
  return settleSwap(paymentPayload, { agent: "revoke", ...meta });
}

/**
 * One-call gasless revoke with everything handled: a free 402 for caps, a 7702
 * designation if the account has no code yet, build + settle + confirm, and an
 * automatic fallback to the DIRECT (ETH) revoke so the kill switch always works.
 * Pass `signAuthorization` (from useActiveWallet) so an undesignated account can
 * still go gasless.
 */
/** The DelegationManager reverts when disabling an already-disabled delegation.
 *  A revoke is idempotent — if it's already off, the user's goal is met — so we
 *  treat this as success rather than surfacing a confusing "revoke failed". */
const isAlreadyDisabled = (e: unknown): boolean =>
  /already\s*disabled|alreadydisabled|already\s*revoked|cannot\s*disable.*disabled/i.test(
    e instanceof Error ? e.message : String(e)
  );

export async function gaslessRevoke(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  context: Hex;
  delegationManager: Hex;
  signAuthorization?: (a: { contractAddress: Hex; chainId: number; nonce: number }) => Promise<Eip7702Authorization>;
  log?: (s: string) => void;
}): Promise<{ ok: boolean; tx?: string | null; viaGasless?: boolean; error?: string; alreadyRevoked?: boolean }> {
  const log = params.log ?? (() => {});
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    log("Revoking · the relayer disables the root for you — gas in USDC, no ETH…");
    const req = await fetch402("/services/researcher");

    // Designate the account (7702) if it has no code yet, so the relayer can
    // execute disableDelegation from it.
    let authorization: Eip7702Authorization | undefined;
    if (params.signAuthorization) {
      const code = await publicClient.getCode({ address: params.userAddress }).catch(() => undefined);
      if (!code || code === "0x") {
        const nonce = await publicClient.getTransactionCount({ address: params.userAddress });
        authorization = await params.signAuthorization({ contractAddress: config.eip7702Impl, chainId: config.chainId, nonce });
      }
    }

    const coordinator = createCoordinatorAccount();
    const { paymentPayload } = await buildGaslessRevoke({
      walletClient: params.walletClient, userAddress: params.userAddress, coordinator,
      context: params.context, req, authorization,
    });
    const r = await settleGaslessRevoke(paymentPayload);
    if (!r.ok) throw new Error(r.error ?? "gasless revoke rejected");

    let tx = r.transaction ?? null;
    if (r.jobId) {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 3000));
        const job = await fetchJob(r.jobId);
        if (!job) continue;
        if (job.status === "failed") throw new Error(job.error ?? "revoke failed on-chain");
        if (job.status === "confirmed") { tx = job.transaction ?? tx; break; }
      }
    }
    return { ok: true, tx, viaGasless: true };
  } catch (gaslessErr) {
    // Idempotent: if it's already disabled, the kill switch already did its job.
    if (isAlreadyDisabled(gaslessErr)) {
      log("This permission is already revoked on-chain — nothing more to do.");
      return { ok: true, tx: null, viaGasless: true, alreadyRevoked: true };
    }
    log(`Gasless revoke unavailable (${msg(gaslessErr)}) — falling back to a direct tx (needs a little ETH)…`);
    try {
      const tx = await revokeRootDelegation({
        walletClient: params.walletClient, userAddress: params.userAddress,
        context: params.context, delegationManager: params.delegationManager,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      return { ok: true, tx, viaGasless: false };
    } catch (e) {
      if (isAlreadyDisabled(e)) {
        log("This permission is already revoked on-chain — nothing more to do.");
        return { ok: true, tx: null, viaGasless: false, alreadyRevoked: true };
      }
      return { ok: false, error: msg(e) };
    }
  }
}
