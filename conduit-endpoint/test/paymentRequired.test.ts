import { describe, expect, it } from "vitest";
import { buildPaymentRequired } from "../src/paymentRequired.js";
import type { ConduitCapabilities } from "../src/facilitatorClient.js";

const caps: ConduitCapabilities = {
  network: "eip155:84532",
  receiptEnforcer: "0x111115259a41bd174c7C1f6B7eE36ec1Ab3CD5c1",
  delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  redeemer: "0x51A4FDB15787bd43FE3C96c49e559526B637bC66",
  relayBackend: "viem-direct",
};

const RESOURCE = "http://localhost:4500/paid-data";

describe("buildPaymentRequired", () => {
  it("produces an x402 V2 envelope with one accepts entry", () => {
    const env = buildPaymentRequired(RESOURCE, caps, "X-PAYMENT header required");
    expect(env.x402Version).toBe(2);
    expect(env.accepts).toHaveLength(1);
    expect(env.error).toBe("X-PAYMENT header required");
  });

  it("advertises erc7710 as the asset transfer method", () => {
    const env = buildPaymentRequired(RESOURCE, caps, "");
    expect(env.accepts[0].extra.assetTransferMethod).toBe("erc7710");
  });

  it("includes the facilitator, redeemer, and receipt enforcer", () => {
    const env = buildPaymentRequired(RESOURCE, caps, "");
    const extra = env.accepts[0].extra;
    expect(extra.facilitator).toMatch(/^https?:\/\//);
    expect(extra.redeemer).toBe(caps.redeemer);
    expect(extra.receiptEnforcer).toBe(caps.receiptEnforcer);
    expect(extra.delegationManager).toBe(caps.delegationManager);
  });

  it("prices the resource in USDC base units (6 decimals)", () => {
    const env = buildPaymentRequired(RESOURCE, caps, "");
    // 0.01 USDC = 10000 base units (set in test/setup.ts)
    expect(env.accepts[0].maxAmountRequired).toBe("10000");
    expect(env.accepts[0].asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("sets payTo and network correctly", () => {
    const env = buildPaymentRequired(RESOURCE, caps, "");
    expect(env.accepts[0].payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(env.accepts[0].network).toBe("eip155:84532");
    expect(env.accepts[0].resource).toBe(RESOURCE);
  });
});
