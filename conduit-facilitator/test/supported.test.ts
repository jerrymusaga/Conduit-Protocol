import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { supportedRouter } from "../src/routes/supported.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(supportedRouter);
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

  it("reports the configured network as CAIP-2", async () => {
    const res = await request(makeApp()).get("/supported");
    expect(res.body.kinds[0].network).toBe("eip155:84532");
  });
});
