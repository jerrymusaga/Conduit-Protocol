/**
 * ERC-8004 discovery: read OUR agents back from the Identity Registry by
 * scanning `Registered` events for our registrant address, then map each to its
 * marketplace entry. This is the real on-chain discovery that replaces the
 * narrated catalog. Falls back to the static catalog when no registrant is
 * configured or nothing is registered yet (pre-registration / local dev), so the
 * demo always has a marketplace to work with.
 */
import { parseAbiItem, type Hex } from "viem";
import { publicClient } from "./chain";
import { config } from "./config";
import { AGENTS, getAgent, type Agent } from "./agents";

// ERC-8004 Identity Registry — Base Sepolia singleton.
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const REGISTERED_EVENT = parseAbiItem(
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
);

export interface DiscoveredAgent extends Agent {
  /** On-chain ERC-8004 token id (when discovered from the registry). */
  agentId?: string;
  /** The registered agentURI (the AgentCard URL). */
  agentURI?: string;
  /** Where this entry came from — proves real registry discovery vs fallback. */
  source: "registry" | "catalog";
}

/** Extract the agent id from an agentURI like ".../api/agent-card/<id>". */
function idFromUri(uri: string): string | undefined {
  const m = uri.match(/\/agent-card\/([^/?#]+)/);
  return m?.[1];
}

/**
 * Discover the marketplace. Reads the ERC-8004 registry on-chain; returns the
 * registered agents (with their on-chain ids). Falls back to the static catalog.
 */
export async function discoverAgents(): Promise<DiscoveredAgent[]> {
  const registrant = process.env.NEXT_PUBLIC_AGENT_REGISTRANT as Hex | undefined;
  if (registrant && config.chainId === 84532) {
    try {
      // Public RPCs cap eth_getLogs at a 2000-block range AND reject toBlock past
      // the head. Our agents register in one tight window, so scan a small fixed
      // window anchored at the registration block (never grows past the limit),
      // capped at the current head. Re-registration should bump
      // NEXT_PUBLIC_AGENT_REGISTRY_FROM_BLOCK.
      const fromBlock = BigInt(process.env.NEXT_PUBLIC_AGENT_REGISTRY_FROM_BLOCK ?? "42517477");
      const head = await publicClient.getBlockNumber();
      const windowEnd = fromBlock + 500n;
      const toBlock = windowEnd < head ? windowEnd : head;
      const logs = await publicClient.getLogs({
        address: REGISTRY,
        event: REGISTERED_EVENT,
        args: { owner: registrant },
        fromBlock,
        toBlock,
      });
      const seen = new Set<string>();
      const discovered: DiscoveredAgent[] = [];
      for (const log of logs) {
        const uri = log.args.agentURI;
        const id = uri ? idFromUri(uri) : undefined;
        if (!id || seen.has(id)) continue;
        const base = getAgent(id);
        if (!base) continue; // a registry entry we don't recognize
        seen.add(id);
        discovered.push({
          ...base,
          agentId: log.args.agentId?.toString(),
          agentURI: uri,
          source: "registry",
        });
      }
      if (discovered.length > 0) return discovered;
    } catch (err) {
      console.warn("[discovery] registry read failed, using catalog:", err);
    }
  }
  // Fallback: the static catalog (pre-registration / local dev / no registrant).
  return AGENTS.map((a) => ({ ...a, source: "catalog" as const }));
}
