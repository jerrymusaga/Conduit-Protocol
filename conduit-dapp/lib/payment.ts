/**
 * The "execute in-grant" beat (handoff step 3). Builds an intent-bound
 * redelegation off the granted root, signs it as the coordinator, and packs the
 * x402 payment payload the endpoint/facilitator consume.
 *
 * Chain (redeemed by the facilitator): [child, ...grantedContext]
 *   - grantedContext: the ERC-7715 root (user smart account → coordinator).
 *   - child: coordinator → facilitator-relayer, carrying
 *       · IdEnforcer            — one-shot replay protection (id = intentHash)
 *       · X402ReceiptEnforcer   — binds token + recipient + amount + intentHash
 *     The leaf delegate is the facilitator relayer, because the DM requires
 *     chain[0].delegate == msg.sender (the relayer submits redeemDelegations).
 *
 * Encodings mirror the proven fork test (test/X402ReceiptEnforcer.fork.t.sol).
 */
import { createExecution, signDelegation } from "@metamask/smart-accounts-kit";
import {
  decodeDelegations,
  encodeDelegations,
  hashDelegation,
  encodeExecutionCalldata,
} from "@metamask/smart-accounts-kit/utils";
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { config } from "./config";
import type { Coordinator, GrantResult } from "./erc7715";
import type { PaymentRequirements } from "./endpoint";

// Structural mirrors of the toolkit's Delegation/Caveat (the package doesn't
// re-export them on a public subpath). Same shape → assignable to the helpers.
type Caveat = { enforcer: Hex; terms: Hex; args: Hex };
type Delegation = {
  delegate: Hex;
  delegator: Hex;
  authority: Hex;
  caveats: Caveat[];
  salt: Hex;
  signature: Hex;
};

/** Built-in IdEnforcer (one-shot) per chain — from delegation-deployments v1.3.0. */
const ID_ENFORCER: Record<number, Hex> = {
  84532: "0xC8B5D93463c893401094cc70e66A206fb5987997", // Base Sepolia
};

function idEnforcer(chainId: number): Hex {
  const addr = ID_ENFORCER[chainId];
  if (!addr) throw new Error(`No IdEnforcer address configured for chain ${chainId}`);
  return addr;
}

const erc20Abi = parseAbi(["function transfer(address to, uint256 amount)"]);

/**
 * A fresh intent hash per run. IdEnforcer is one-shot, so reusing a hash is
 * exactly the replay case — keep this unique by mixing in a random salt.
 */
export function freshIntentHash(req: PaymentRequirements): Hex {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16))); // bytes16
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes16" },
      ],
      [req.resource, req.payTo, req.asset, BigInt(req.maxAmountRequired), salt]
    )
  );
}

export interface BuiltPayment {
  /** x402 payment payload to base64 into the X-PAYMENT header. */
  paymentPayload: unknown;
  intentHash: Hex;
  /** Amount transferred, in token base units. */
  amount: bigint;
  payTo: `0x${string}`;
}

/**
 * Build + sign the intent-bound redelegation and assemble the x402 payload.
 * `intentHash` is optional so the replay test can deliberately reuse a prior one.
 */
export async function buildPayment(params: {
  grant: GrantResult;
  coordinator: Coordinator;
  req: PaymentRequirements;
  intentHash?: Hex;
  /** Override recipient/amount for the break-it tests; defaults to the honest values. */
  payToOverride?: `0x${string}`;
  amountOverride?: bigint;
}): Promise<BuiltPayment> {
  const { grant, coordinator, req } = params;
  if (!req.redeemer) {
    throw new Error("facilitator advertised no redeemer (not on viem-direct?)");
  }

  const token = req.asset;
  const honestPayTo = req.payTo;
  const honestAmount = BigInt(req.maxAmountRequired);
  // What the enforcer is BOUND to (the honest intent):
  const intentHash = params.intentHash ?? freshIntentHash(req);
  const maxAmount = honestAmount;
  // What the execution actually attempts (lets break-it tests diverge):
  const execPayTo = params.payToOverride ?? honestPayTo;
  const execAmount = params.amountOverride ?? honestAmount;

  // ---- caveats: [IdEnforcer, X402ReceiptEnforcer] (order matches fork test) --
  const idCaveat: Caveat = {
    enforcer: idEnforcer(config.chainId),
    terms: encodeAbiParameters([{ type: "uint256" }], [BigInt(intentHash)]),
    args: "0x",
  };
  const x402Caveat: Caveat = {
    enforcer: req.receiptEnforcer,
    // 89 bytes packed: intentHash(32) token(20) recipient(20) maxAmount(uint128) flags(uint8)
    terms: encodePacked(
      ["bytes32", "address", "address", "uint128", "uint8"],
      [intentHash, token, honestPayTo, maxAmount, 0]
    ),
    args: "0x",
  };

  // ---- child delegation: coordinator -> facilitator relayer ------------------
  const parentChain = decodeDelegations(grant.context);
  const immediateParent = parentChain[0]; // chain is [leaf..root]; redelegate off the leaf
  const rootDelegator = parentChain[parentChain.length - 1].delegator; // the payer (user SA)

  const unsignedChild: Omit<Delegation, "signature"> = {
    delegate: req.redeemer,
    delegator: coordinator.address,
    authority: hashDelegation(immediateParent),
    caveats: [idCaveat, x402Caveat],
    salt: intentHash, // unique per run
  };

  const signature = await signDelegation({
    privateKey: coordinator.privateKey,
    delegation: unsignedChild,
    delegationManager: grant.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  const child: Delegation = { ...unsignedChild, signature };

  const permissionContext = encodeDelegations([child, ...parentChain]);

  // ---- execution: USDC.transfer(execPayTo, execAmount) -----------------------
  const execution = createExecution({
    target: token,
    value: 0n,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [execPayTo, execAmount],
    }),
  });
  const executionCallData = encodeExecutionCalldata([execution]);

  const paymentPayload = {
    x402Version: 2,
    scheme: req.scheme,
    network: req.network,
    payload: {
      delegationManager: grant.delegationManager,
      permissionContext,
      delegator: rootDelegator,
      executionCallData,
      // mode omitted → facilitator defaults to single-call default-exec.
    },
  };

  return { paymentPayload, intentHash, amount: execAmount, payTo: execPayTo };
}
