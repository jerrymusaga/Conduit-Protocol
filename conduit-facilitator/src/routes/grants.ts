import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { registerGrant, listGrants, revokeGrant, type GrantKind } from "../grants.js";

/**
 * The grants registry API — backs the /portfolio page.
 *
 *   POST /grants            — register a grant the user just signed.
 *   GET  /grants?user=0x..  — every grant that wallet signed (newest first).
 *   POST /grants/:id/revoke — mark a grant revoked (after disableDelegation).
 *
 * ERC-7715 grants are signed off-chain (no on-chain "created" event) and the
 * enforcer events key by delegationHash, not the user account — so this is the
 * only way to enumerate "all permissions for wallet X". Live state (budget left,
 * period, status) is still read on-chain by the dapp; this stores the index.
 */

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const grantSchema = z.object({
  id: z.string().min(1).optional(),
  user: hexAddress,
  kind: z.enum(["budget", "subscription", "swap"]),
  label: z.string().max(200).default(""),
  prompt: z.string().max(2000).optional(),
  coordinator: z.string().optional(),
  token: z.string().optional(),
  amount: z.string().optional(),
  expiry: z.number().int().nonnegative().optional(),
  periodSeconds: z.number().int().positive().optional(),
  delegationHash: z.string().optional(),
  enforcer: z.string().optional(),
  merchant: z.string().optional(),
  context: z.string().max(20000).optional(),
});

export function grantsRouter(): Router {
  const router = Router();

  router.post("/grants", (req: Request, res: Response) => {
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "malformed grant: " + parsed.error.issues[0]?.message });
    }
    const rec = registerGrant({ ...parsed.data, kind: parsed.data.kind as GrantKind });
    return res.json({ grant: rec });
  });

  router.get("/grants", (req: Request, res: Response) => {
    const user = req.query.user;
    if (typeof user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
      return res.status(400).json({ error: "missing or invalid ?user=0x..." });
    }
    return res.json({ grants: listGrants(user) });
  });

  router.post("/grants/:id/revoke", (req: Request, res: Response) => {
    const raw: unknown = req.body?.user ?? req.query.user;
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      return res.status(400).json({ error: "missing or invalid user" });
    }
    const id = req.params.id ?? "";
    const rec = revokeGrant(id, raw);
    if (!rec) return res.status(404).json({ error: "grant not found" });
    return res.json({ grant: rec });
  });

  return router;
}
