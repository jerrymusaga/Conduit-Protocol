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
import type { Coordinator, GrantResult } from "./grant";
import type { PaymentRequirements } from "./endpoint";

/**
 * EIP-7702 authorization tuple (Privy's `useSign7702Authorization` returns
 * this exact shape). Bundled into the first redeem by the facilitator so the
 * user's EOA is upgraded to a smart account in the same tx as the payment.
 */
export interface Eip7702Authorization {
  chainId: number;
  address: `0x${string}`;
  nonce: number;
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: 0 | 1;
}

// Structural mirrors of the toolkit's Delegation/Caveat (the package doesn't
// re-export them on a public subpath). Same shape → assignable to the helpers.
export type Caveat = { enforcer: Hex; terms: Hex; args: Hex };
export type Delegation = {
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
  /** Bundle a signed EIP-7702 authorization into the redeem (first run only). */
  authorization?: Eip7702Authorization;
  /**
   * Optional specialist agent for a real 3-hop A2A chain. When present, the
   * coordinator redelegates to this sub-agent (no caveats — scope-narrowing
   * happens on the sub-agent's hop), and the sub-agent signs the intent-bound
   * redelegation to the relayer. Chain becomes
   * [subChild, coordChild, ...grantedContext]. When absent, the coordinator
   * pays directly (2-hop), which is the looped-payments path.
   */
  subAgent?: Coordinator;
}): Promise<BuiltPayment> {
  const { grant, coordinator, req, subAgent } = params;
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

  const parentChain = decodeDelegations(grant.context);
  const immediateParent = parentChain[0]; // chain is [leaf..root]; redelegate off the leaf
  const rootDelegator = parentChain[parentChain.length - 1].delegator; // the payer (user SA)

  // The intent-bound, relayer-targeted leaf is signed by whoever spends:
  //   - 3-hop (A2A): the sub-agent signs it, authority = the coordinator's hop.
  //   - 2-hop: the coordinator signs it, authority = the granted root's leaf.
  const extraHops: Delegation[] = [];
  let leafSigner = coordinator;
  let leafAuthority = hashDelegation(immediateParent);

  if (subAgent) {
    // Coordinator → sub-agent hop (open redelegation; scope rides the next hop).
    const unsignedCoordHop: Omit<Delegation, "signature"> = {
      delegate: subAgent.address,
      delegator: coordinator.address,
      authority: hashDelegation(immediateParent),
      caveats: [],
      salt: intentHash,
    };
    const coordSig = await signDelegation({
      privateKey: coordinator.privateKey,
      delegation: unsignedCoordHop,
      delegationManager: grant.delegationManager,
      chainId: config.chainId,
      name: "DelegationManager",
      version: "1",
      // This hop intentionally carries no caveats — the intent binding lives on
      // the sub-agent's leaf hop. Opt in so the kit signs the open redelegation.
      allowInsecureUnrestrictedDelegation: true,
    });
    const coordHop: Delegation = { ...unsignedCoordHop, signature: coordSig };
    extraHops.push(coordHop);
    leafSigner = subAgent;
    leafAuthority = hashDelegation(coordHop);
  }

  // ---- leaf delegation: (sub-agent | coordinator) -> facilitator relayer -----
  const unsignedChild: Omit<Delegation, "signature"> = {
    delegate: req.redeemer,
    delegator: leafSigner.address,
    authority: leafAuthority,
    caveats: [idCaveat, x402Caveat],
    salt: intentHash, // unique per run
  };

  const signature = await signDelegation({
    privateKey: leafSigner.privateKey,
    delegation: unsignedChild,
    delegationManager: grant.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  const child: Delegation = { ...unsignedChild, signature };

  // Chain order is [leaf, …, root]: leaf first, then any A2A hops, then root.
  const permissionContext = encodeDelegations([child, ...extraHops, ...parentChain]);

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
      // Include the EIP-7702 auth when present; the facilitator bundles it
      // into the redeem via `authorizationList`, designating the user EOA
      // to the StatelessDeleGator in the same tx as the payment.
      ...(params.authorization ? { authorization: params.authorization } : {}),
    },
  };

  return { paymentPayload, intentHash, amount: execAmount, payTo: execPayTo };
}

// --- 1Shot (oneshot-pl) path -----------------------------------------------

/** Ceiling the bounded fee delegation allows 1Shot to charge (USDC atoms).
 *  The real fee comes from a live quote ≤ this; binding a cap keeps it
 *  Conduit-style (can only ever pay feeCollector, never above the cap).
 *  Sized with headroom for 1Shot's Base Sepolia gas-in-USDC quotes — too low
 *  a cap makes the bounded fee delegation revert X402Receipt:amount-exceeds-cap
 *  when the live quote exceeds it. The user still only pays the quote, not the cap. */
export const FEE_CAP_ATOMS = 300_000n; // 0.30 USDC ceiling (actual fee = live quote ≤ this)

/** Build + sign ONE intent-bound redelegation CHAIN [leaf,…,root], structured
 *  (not hex-encoded) for 1Shot. The leaf is bound by X402ReceiptEnforcer to
 *  (token, recipient, maxAmount, intentHash) + IdEnforcer(one-shot). */
export async function buildBoundChain(params: {
  grant: GrantResult;
  coordinator: Coordinator;
  redeemer: Hex;
  token: Hex;
  recipient: Hex;
  maxAmount: bigint;
  intentHash: Hex;
  /** Optional specialist for a real 3-hop A2A chain (coordinator → sub → relayer). */
  subAgent?: Coordinator;
}): Promise<Delegation[]> {
  const { grant, coordinator, redeemer, token, recipient, maxAmount, intentHash, subAgent } = params;
  const idCaveat: Caveat = {
    enforcer: idEnforcer(config.chainId),
    terms: encodeAbiParameters([{ type: "uint256" }], [BigInt(intentHash)]),
    args: "0x",
  };
  const x402Caveat: Caveat = {
    enforcer: config.receiptEnforcer as Hex,
    terms: encodePacked(
      ["bytes32", "address", "address", "uint128", "uint8"],
      [intentHash, token, recipient, maxAmount, 0]
    ),
    args: "0x",
  };
  const parentChain = decodeDelegations(grant.context);
  const immediateParent = parentChain[0];

  // A2A: coordinator → sub-agent open hop; the sub-agent signs the bound leaf.
  const extraHops: Delegation[] = [];
  let leafSigner = coordinator;
  let leafAuthority = hashDelegation(immediateParent);
  if (subAgent) {
    const unsignedCoordHop: Omit<Delegation, "signature"> = {
      delegate: subAgent.address,
      delegator: coordinator.address,
      authority: hashDelegation(immediateParent),
      caveats: [],
      salt: intentHash,
    };
    const coordSig = await signDelegation({
      privateKey: coordinator.privateKey,
      delegation: unsignedCoordHop,
      delegationManager: grant.delegationManager,
      chainId: config.chainId,
      name: "DelegationManager",
      version: "1",
      allowInsecureUnrestrictedDelegation: true, // open hop; binding rides the leaf
    });
    const coordHop: Delegation = { ...unsignedCoordHop, signature: coordSig };
    extraHops.push(coordHop);
    leafSigner = subAgent;
    leafAuthority = hashDelegation(coordHop);
  }

  const unsignedChild: Omit<Delegation, "signature"> = {
    delegate: redeemer,
    delegator: leafSigner.address,
    authority: leafAuthority,
    caveats: [idCaveat, x402Caveat],
    salt: intentHash,
  };
  const signature = await signDelegation({
    privateKey: leafSigner.privateKey,
    delegation: unsignedChild,
    delegationManager: grant.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  // Chain order [leaf, …, root]: bound leaf, then any A2A hops, then the grant.
  return [{ ...unsignedChild, signature }, ...extraHops, ...parentChain];
}

export interface BuiltOneshotPayment {
  paymentPayload: unknown;
  intentHash: Hex;
  amount: bigint;
  payTo: `0x${string}`;
}

/**
 * Build the x402 payload for the oneshot-pl (1Shot) backend: TWO bounded
 * delegation chains rooted in the same grant —
 *   - WORK: pay the seller (req.payTo, req.maxAmountRequired), the real intent.
 *   - FEE:  pay 1Shot's feeCollector, capped at FEE_CAP (the backend fills the
 *           exact quoted amount ≤ cap). Both bound by X402ReceiptEnforcer, so
 *           even the gas payment can't be redirected.
 * The work execution is included; the backend builds the fee execution from the
 * live quote. The 7702 auth (first run) bundles into the relayer's tx.
 */
export async function buildOneshotPayment(params: {
  grant: GrantResult;
  coordinator: Coordinator;
  req: PaymentRequirements;
  intentHash?: Hex;
  authorization?: Eip7702Authorization;
  /** Specialist sub-agent → real 3-hop A2A on the work leg (fee leg stays direct). */
  subAgent?: Coordinator;
}): Promise<BuiltOneshotPayment> {
  const { grant, coordinator, req, subAgent } = params;
  if (!req.redeemer) throw new Error("402 advertised no redeemer (targetAddress)");
  if (!req.feeCollector) throw new Error("402 advertised no feeCollector (oneshot-pl)");

  const token = req.asset;
  const payTo = req.payTo;
  const workAmount = BigInt(req.maxAmountRequired);
  const workIntent = params.intentHash ?? freshIntentHash(req);
  // A distinct one-shot id for the fee leg (sibling off the same coordinator hop).
  const feeIntent = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [workIntent, "fee"])
  );

  const [workChain, feeChain] = await Promise.all([
    buildBoundChain({
      grant, coordinator, redeemer: req.redeemer, token,
      recipient: payTo, maxAmount: workAmount, intentHash: workIntent,
      subAgent, // 3-hop A2A on the work payment when present
    }),
    buildBoundChain({
      grant, coordinator, redeemer: req.redeemer, token,
      recipient: req.feeCollector, maxAmount: FEE_CAP_ATOMS, intentHash: feeIntent,
    }),
  ]);

  const workExecution = {
    target: token,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi, functionName: "transfer", args: [payTo, workAmount],
    }),
  };

  const rootDelegator = decodeDelegations(grant.context).slice(-1)[0].delegator;

  const paymentPayload = {
    x402Version: 2,
    scheme: req.scheme,
    network: req.network,
    payload: {
      delegationManager: grant.delegationManager,
      // Kept for schema compatibility; the oneshot path uses the structured block.
      permissionContext: encodeDelegations(workChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({
          target: token, value: 0n,
          callData: encodeFunctionData({
            abi: erc20Abi, functionName: "transfer", args: [payTo, workAmount],
          }),
        }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: {
        paymentToken: token,
        workChain,
        workExecution,
        feeChain,
      },
    },
  };

  return { paymentPayload, intentHash: workIntent, amount: workAmount, payTo };
}
