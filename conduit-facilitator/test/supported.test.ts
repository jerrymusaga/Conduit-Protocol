import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { supportedRouter } from "../src/routes/supported.js";
import type { RelayBackend } from "../src/relayers/types.js";

const stubBackend: RelayBackend = {
  name: "viem-direct",
  redeemer: "0x51A4FDB15787bd43FE3C96c49e559526B637bC66",
  async submit() {
    return { jobId: "stub", status: "pending" };
  },
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(supportedRouter(stubBackend));
  return app;
}

describe("GET /supported", () => {
  it("advertises erc7710 as an asset transfer method", async () => {
    const res = await request(makeApp()).get("/supported");
    expect(res.status).toBe(200);
    const kind = res.body.kinds[0];
    expect(kind.extra.assetTransferMethods).toContain("erc7710");
  });

  it("surfaces the Conduit receipt enforcer address", async () => {
    const res = await request(makeApp()).get("/supported");
    expect(res.body.kinds[0].extra.conduit.receiptEnforcer).toMatch(
      /^0x[0-9a-fA-F]{40}$/
    );
  });

  it("surfaces the redeemer address from the active backend", async () => {
    const res = await request(makeApp()).get("/supported");
    expect(res.body.kinds[0].extra.conduit.redeemer).toBe(
      "0x51A4FDB15787bd43FE3C96c49e559526B637bC66"
    );
  });

  it("reports the configured network as CAIP-2", async () => {
    const res = await request(makeApp()).get("/supported");
    expect(res.body.kinds[0].network).toBe("eip155:84532");
  });
});
