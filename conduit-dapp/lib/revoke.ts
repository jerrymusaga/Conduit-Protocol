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
import { grantBudget } from "./grant";
import { buildBoundChain, feeCapAtoms, type Delegation, type Eip7702Authorization } from "./payment";
import type { PaymentRequirements } from "./endpoint";
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
