import { describe, expect, it } from "vitest";
import {
  facilitatorRequestSchema,
  paymentPayloadSchema,
  toRelayParams,
} from "../src/x402.js";

const ZERO_MODE = "0x" + "00".repeat(32);

const validPayload = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:84532",
  payload: {
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    permissionContext: "0xabcdef",
    delegator: "0x2e234DAe75C793f67A35089C9d99245E1C58470b",
    executionCallData: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  },
};

describe("paymentPayloadSchema", () => {
  it("accepts a well-formed erc7710 payload", () => {
    const r = paymentPayloadSchema.safeParse(validPayload);
    expect(r.success).toBe(true);
  });

  it("rejects a non-address delegationManager", () => {
    const bad = structuredClone(validPayload);
    bad.payload.delegationManager = "0xnot-an-address";
    const r = paymentPayloadSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects non-hex permissionContext", () => {
    const bad = structuredClone(validPayload);
    bad.payload.permissionContext = "not-hex";
    const r = paymentPayloadSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("accepts an optional EIP-7702 authorization", () => {
    const withAuth = structuredClone(validPayload) as Record<string, unknown>;
    (withAuth.payload as Record<string, unknown>).authorization = {
      chainId: 84532,
      address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
      nonce: 0,
      r: "0x" + "11".repeat(32),
      s: "0x" + "22".repeat(32),
      yParity: 1,
    };
    const r = paymentPayloadSchema.safeParse(withAuth);
    expect(r.success).toBe(true);
  });
});

describe("facilitatorRequestSchema", () => {
  it("accepts a request wrapping a payment payload", () => {
    const r = facilitatorRequestSchema.safeParse({
      x402Version: 2,
      paymentPayload: validPayload,
      paymentRequirements: { anything: "goes" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects when paymentPayload is missing", () => {
    const r = facilitatorRequestSchema.safeParse({ x402Version: 2 });
    expect(r.success).toBe(false);
  });
});

describe("toRelayParams", () => {
  it("wraps single values into one-element arrays", () => {
    const parsed = paymentPayloadSchema.parse(validPayload);
    const params = toRelayParams(parsed);
    expect(params.permissionContexts).toEqual(["0xabcdef"]);
    expect(params.executionCallDatas).toEqual([
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    ]);
    expect(params.modes).toEqual([ZERO_MODE]);
  });

  it("defaults mode to single-call default-exec when omitted", () => {
    const parsed = paymentPayloadSchema.parse(validPayload);
    const params = toRelayParams(parsed);
    expect(params.modes[0]).toBe(ZERO_MODE);
  });

  it("preserves an explicit mode", () => {
    const withMode = structuredClone(validPayload);
    (withMode.payload as Record<string, unknown>).mode = "0x" + "01".repeat(32);
    const parsed = paymentPayloadSchema.parse(withMode);
    const params = toRelayParams(parsed);
    expect(params.modes[0]).toBe("0x" + "01".repeat(32));
  });

  it("carries the EIP-7702 authorization through when present", () => {
    const withAuth = structuredClone(validPayload) as Record<string, unknown>;
    (withAuth.payload as Record<string, unknown>).authorization = {
      chainId: 84532,
      address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
      nonce: 3,
      r: "0x" + "11".repeat(32),
      s: "0x" + "22".repeat(32),
      yParity: 0,
    };
    const parsed = paymentPayloadSchema.parse(withAuth);
    const params = toRelayParams(parsed);
    expect(params.authorization?.nonce).toBe(3);
    expect(params.authorization?.chainId).toBe(84532);
  });
});
