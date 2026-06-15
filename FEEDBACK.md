# Hackathon Feedback — Conduit

This feedback is grounded in building **Conduit**, an x402 + ERC-7710 facilitator
with a custom `CaveatEnforcer` family on MetaMask Smart Accounts, settling through
the 1Shot Permissionless Relayer with Venice as the agent intelligence — deployed and
verified on Base mainnet. We integrated MetaMask Delegation Framework v1.3.0, ERC-7715
Advanced Permissions, EIP-7702, the 1Shot relayer (gas in USDC + webhooks), Venice
(multiple endpoints), ERC-8004, Privy embedded wallets, and a WebAuthn-PRF passkey
wallet. So the notes below come from real, deep integration, not surface usage.

Each item is: **what we hit → why it cost time → a concrete suggestion.**

---

## MetaMask Smart Accounts / Delegation Framework / Advanced Permissions

**1. The biggest undocumented wall: MetaMask blocks dapp-signed raw delegations for
its own accounts.**
A dapp-initiated `signTypedData_v4` of a DelegationManager `Delegation` whose
`delegator` is a MetaMask account fails with:
`"External signature requests cannot sign delegations for internal accounts."
(InternalRpcError -32603)`.
We spent significant time because the error is opaque (it surfaces through viem as a
generic `UnknownRpcError`/`InternalRpcError`) and nothing in the Delegation Framework
docs says "you cannot create a delegation for a MetaMask account by signing the
EIP-712 `Delegation` directly — you must use ERC-7715 `wallet_requestExecutionPermissions`."
- **Suggestion:** document this prominently in the Delegation Framework / Smart
  Accounts Kit README ("Creating delegations for MetaMask accounts → use ERC-7715,
  not raw signTypedData"), and have MetaMask return a typed, named error
  (`-32xxx delegation_requires_grant_permissions`) with a docs link instead of
  "internal error".

**2. MetaMask Embedded Wallets (Web3Auth) can't back a 7702 + ERC-7710 + relayer
architecture — surprising, given it's the same brand as the Delegation Framework.**
We tried to go "all MetaMask" for login by replacing our embedded signer with MetaMask
Embedded Wallets (`@web3auth/modal` v11) and inspected the SDK directly. It does not fit
a delegation / 7702-settlement model:
- **No `signAuthorization` anywhere** in `@web3auth/modal` / `@web3auth/no-modal` (0
  matches) — so there is no way to produce the raw **EIP-7702 authorization tuple** a
  type-4 settle tx needs (Privy exposes `useSign7702Authorization`; MM-EW has no
  equivalent).
- Its smart accounts (incl. the EIP-7702 mode) are **ERC-4337 / bundler-based** —
  execution is UserOperations through its own bundler + EntryPoint, **not
  `redeemDelegations` through a relayer** like 1Shot. Adopting it means abandoning the
  relayer settlement path.
- Its `./x402` module signs **EIP-3009 `transferWithAuthorization`**, not ERC-7710 — a
  different settlement lane than an enforcer-bound delegation.
- The only route to a raw 7702 auth is private-key export (`eth_private_key`), which
  **403'd** for us — too fragile to build an architecture on.
- **Suggestion:** expose a first-class `signAuthorization` (raw EIP-7702 auth) in
  MetaMask Embedded Wallets, and document clearly whether MM-EW is meant to support the
  **DeleGator / `redeemDelegations`** path or only its 4337 bundler path. As of now,
  choosing MM-EW for login silently costs you the delegation + relayer settlement model
  — the exact thing the MetaMask Delegation Framework is for.

**3. ERC-7715 only delegates token-spending — there is no permission to delegate an
arbitrary contract call.**
The permission catalog is `native/erc20 token stream | periodic | allowance |
revocation`. That covers budgets and recurring transfers, but a bounded *swap*
(`router.exactInputSingle`) or *deposit* (`pool.supply`) requires delegating an
execution, which ERC-7715 cannot express. Combined with #1 (raw delegations blocked),
there is currently **no MetaMask-native way for an agent to make a bounded non-transfer
call** on the user's behalf. We had to route those flows through embedded/passkey
signers (still MetaMask Smart Accounts via the 7702 DeleGator), and keep MetaMask for
the budget/subscription flows.
- **Suggestion:** an ERC-7715 permission type that delegates a bounded *call* (a
  target/selector allowlist + value/amount caps), or first-class support for attaching
  a custom `CaveatEnforcer` to a granted permission's `rules`. This is the single
  feature that would let "safe agentic DeFi on MetaMask" exist.

**4. The `@metamask/delegation-toolkit` → `@metamask/smart-accounts-kit` rename.**
The deprecated package (0.13.0) sends an older `wallet_requestExecutionPermissions`
wire format that current MetaMask rejects with "Missing or invalid parameters". Many
public examples and search results still reference the old package, and the migration
is easy to miss.
- **Suggestion:** a clear migration note + a deprecation warning on install that names
  the replacement and the minimum compatible MetaMask version.

**5. The ERC-7715 request/response shape is hard to discover.**
We reverse-engineered it from the package's `.d.ts`: request is
`PermissionRequestParameter[]` (`{ chainId, to, from?, expiry?, permission }`), and the
response is `PermissionResponse[]` with `{ context, delegationManager, dependencies }`.
A worked, end-to-end example for "grant an erc20-token-periodic budget, then redeem a
redelegation against the returned `context`" would have saved a day.
- **Suggestion:** one canonical, current example repo (the `templated-gator` idea, kept
  in lockstep with `smart-accounts-kit` versions) showing grant → redelegate → redeem.

**6. EIP-7702 + injected MetaMask: no dapp-accessible `signAuthorization`.**
There is no standard way for a dapp to ask the injected MetaMask provider to sign a
raw 7702 authorization (Privy embedded exposes `useSign7702Authorization`; the
extension does not). The upgrade only happens inside MetaMask's own grant UI.
Undocumented; we discovered it by elimination.
- **Suggestion:** document the supported 7702 entry points per wallet type.

**7. 7702-delegated accounts hit the relayer's in-flight transaction limit.**
Deploying our contracts from an account we had manually upgraded to a smart account
failed mid-broadcast with `-32000 "in-flight transaction limit reached for delegated
accounts"`. `forge script --slow` fixes it, but the error is cryptic and the cause
(the deployer being a 7702 account) is non-obvious.
- **Suggestion:** note this in the 7702 + tooling docs.

## 1Shot Permissionless Relayer

**Strong, well-fitting product** — gas in USDC + bundled 7702 + `estimate7710Transaction`
+ webhooks made our facilitator genuinely simple, and the multichain relayer
(`send7710TransactionMultichain`) is a real differentiator we want to build on. Two
sharp edges:

**8. Webhook signature verification was the trickiest part.**
Getting `relayer-webhook` verification right required: pulling the right key from the
JWKS by `keyId`, using a stable stringify, and — critically — handling a
double-serialization quirk where the relayer's signed payload had to be verified in
both its raw and re-serialized forms. The published guidance did not match observed
behavior here.
- **Suggestion:** a reference verifier snippet (exact canonicalization + JWKS keyId
  lookup) and a documented note about the serialization, plus a webhook payload sample
  with a known-good signature to test against.

**9. Per-chain redeemer/feeCollector and the relayer URL.**
Capabilities differ per chain (`targetAddress`, `feeCollector`), and the relayer URL
auto-derives `.dev`/`.com` from chain id unless overridden — easy to leave a testnet
URL pinned in env and silently keep hitting testnet on a mainnet cutover.
- **Suggestion:** a one-call "is this relayer provisioned for chain X with token Y"
  check, and a louder mismatch warning when the configured URL's chain ≠ the request.

## Venice AI

**Excellent for agentic use** — one API for chat, web-search, reasoning, image, TTS,
STT, and crypto-RPC let a single user prompt fan out across six endpoints, all paid
through our facilitator. The breadth is the selling point and it delivered.
- **Minor suggestion (9):** the image model occasionally renders a small watermark
  despite "no text" in the prompt; a documented negative-prompt or a `no_watermark`
  flag for paid use would help. Clearer per-model rate-limit headers would also help
  client-side backoff.

## x402 / ERC-7710 spec + general

**11. The "is this actually deployed and working" gap.**
The x402 spec describes the protocol, not which facilitators implement `erc7710`
on which chains today. Early on we burned time probing facilitators to find one that
actually supported the method live. A maintained capability matrix (facilitator ×
chain × method) would help every team pick a viable path on day one.

**12. Opaque errors across the stack cost the most time, cumulatively.**
viem's `UnknownRpcError`/`InternalRpcError` wrappers hide the real cause one or two
`.cause` levels down; MetaMask's "internal error" hides a policy decision; the relayer
and Privy both surface generic messages. We ended up writing a cause-chain walker just
to see real errors.
- **Suggestion (cross-cutting):** typed, named errors with docs links at each layer.
  This single thing would have saved us more time than any feature.

**13. Chrome third-party-cookie / embedded-auth edge.**
A restored Privy session left the account `authenticated` but not connected to wagmi,
so a gated route stuck on the sign-in screen and `login()` no-op'd ("already logged
in") — Chrome-only (stored session), fine in Firefox. Worth a documented pattern for
"authenticated but no active wallet → connect/link, don't login".

**14. WebAuthn-PRF device fragmentation.**
PRF is the right primitive for a passkey-derived key, but support is fragmented
(works on Chrome/Android; no PRF on Firefox; macOS needs Sequoia/15). There is no good
runtime capability probe, so we built device-support handling by trial. A standard
"does this authenticator support PRF" pre-flight would help.

---

## What worked well (so the signal is balanced)

- **MetaMask Delegation Framework** as a *primitive* is excellent — `CaveatEnforcer`'s
  `beforeHook` extension point let us ship a whole family of safety caveats with no
  changes to the DelegationManager, and the caveat-chain "narrow, never widen" walk is
  exactly the right security model for agents.
- **1Shot** turned "run a relayer + pay gas" into a few JSON-RPC calls, and gas-in-USDC
  + bundled 7702 is the right UX for agents.
- **Venice's** single multi-modal API is a genuine unlock for agent capability.
- **EIP-7702** is the cleanest path to "your EOA is now a smart account" and it just
  worked once we understood the signing paths.

## Top 3 suggestions, prioritized

1. **A typed, documented MetaMask error + a docs section** for "you must use ERC-7715
   to create delegations for MetaMask accounts" (replaces the opaque "internal error"
   that cost us the most time).
2. **An ERC-7715 permission (or `rules` hook) that delegates a bounded contract call**,
   so safe agentic swaps/deposits are expressible on the MetaMask extension at all.
3. **Typed, named errors with docs links across the stack** (MetaMask, viem, 1Shot,
   Privy). Cumulatively the single highest-leverage improvement for builders.
