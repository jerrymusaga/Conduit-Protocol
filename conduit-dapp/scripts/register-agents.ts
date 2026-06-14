/**
 * One-time: register every marketplace agent on the ERC-8004 Identity Registry
 * (Base Sepolia singleton). Each agent's on-chain `agentURI` points at its
 * AgentCard route on the dapp; discovery later reads these back via the
 * Registered events filtered by the registrant address.
 *
 * Usage (from conduit-dapp/):
 *   REGISTRANT_PRIVATE_KEY=0x...            # funded with a little Base Sepolia ETH
 *   AGENT_CARD_BASE=https://conduit-protocol.vercel.app   # where the cards are served
 *   RPC_URL=https://sepolia.base.org       # optional (dedicated key recommended)
 *   npx tsx scripts/register-agents.ts
 *
 * After it runs, set NEXT_PUBLIC_AGENT_REGISTRANT to the printed address so the
 * dapp's discovery filters Registered events to OUR agents.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  toHex,
  decodeEventLog,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { AGENTS } from "../lib/agents";

// ERC-8004 Identity Registry singletons — follows CHAIN_ID (default Base Sepolia).
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "84532");
const CHAINS: Record<number, { chain: Chain; registry: Hex; rpc: string }> = {
  84532: { chain: baseSepolia, registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", rpc: "https://sepolia.base.org" },
  8453: { chain: base, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", rpc: "https://mainnet.base.org" },
};
const CHAIN = CHAINS[CHAIN_ID];
if (!CHAIN) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID} (known: 84532, 8453)`);
const REGISTRY = CHAIN.registry;

const RPC = process.env.RPC_URL ?? CHAIN.rpc;
const CARD_BASE = (process.env.AGENT_CARD_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const PK = process.env.REGISTRANT_PRIVATE_KEY as Hex | undefined;

const abi = parseAbi([
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",
  "function register(string agentURI, MetadataEntry[] metadata) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

async function main() {
  if (!PK) throw new Error("set REGISTRANT_PRIVATE_KEY (a funded EOA on the target chain)");
  const account = privateKeyToAccount(PK);
  const wallet = createWalletClient({ account, chain: CHAIN.chain, transport: http(RPC) });
  const pub = createPublicClient({ chain: CHAIN.chain, transport: http(RPC) });

  console.log(`registrant: ${account.address}`);
  console.log(`registry:   ${REGISTRY}`);
  console.log(`card base:  ${CARD_BASE}`);
  console.log(`agents:     ${AGENTS.length}\n`);

  const out: { id: string; agentId: string; tx: string }[] = [];
  let firstBlock: bigint | null = null;
  for (const agent of AGENTS) {
    const agentURI = `${CARD_BASE}/api/agent-card/${agent.id}`;
    const metadata = [
      { metadataKey: "role", metadataValue: toHex(agent.role) },
      { metadataKey: "paymentKind", metadataValue: toHex(agent.paymentKind) },
      { metadataKey: "priceUsdc", metadataValue: toHex(agent.priceUsdc) },
    ];
    process.stdout.write(`registering ${agent.id} … `);
    // A 7702-DELEGATED registrant is capped to one in-flight tx by Base's RPC, so
    // submit strictly one at a time: explicit pending nonce + retry-with-backoff on
    // the "in-flight transaction limit" error until the prior tx fully clears.
    let hash: Hex | undefined;
    for (let attempt = 0; attempt < 8 && !hash; attempt++) {
      try {
        const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
        hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: "register", args: [agentURI, metadata], nonce });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/in-flight transaction limit|nonce|already known|replacement/i.test(msg)) {
          const waitMs = 4000 * (attempt + 1);
          process.stdout.write(`(in-flight limit, retrying in ${waitMs / 1000}s) `);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw e;
      }
    }
    if (!hash) throw new Error(`could not submit registration for ${agent.id} after retries`);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (firstBlock === null) firstBlock = receipt.blockNumber;
    // Pull the agentId out of the Registered event.
    let agentId = "?";
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === "Registered") {
          agentId = (ev.args as { agentId: bigint }).agentId.toString();
          break;
        }
      } catch {
        /* not our event */
      }
    }
    console.log(`agentId=${agentId}  tx=${hash}`);
    out.push({ id: agent.id, agentId, tx: hash });
    // Let the sequencer clear this tx from the delegated account's in-flight set
    // before submitting the next one.
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\nregistered agents:");
  console.table(out);
  console.log(`\n➡  set these in the dapp env, then redeploy:`);
  console.log(`     NEXT_PUBLIC_AGENT_REGISTRANT=${account.address}`);
  // Discovery scans a fixed 500-block window from this block, so re-registration
  // MUST bump it to the new window or the fresh agents won't be discovered.
  console.log(`     NEXT_PUBLIC_AGENT_REGISTRY_FROM_BLOCK=${firstBlock ?? "<first-reg-block>"}`);
  console.log("   discovery will then read these agents back from the registry.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
