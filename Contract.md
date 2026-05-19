# Conduit — Contracts

On-chain layer for Conduit's x402 + ERC-7710 payment system. One contract,
two test suites, one deploy script.

```
src/
└── X402ReceiptEnforcer.sol      The caveat enforcer that binds a delegation
                                 redemption to a specific x402 payment intent.
                                 Inherits CaveatEnforcer from MetaMask's
                                 delegation-framework (installed as a forge lib).

test/
├── X402ReceiptEnforcer.t.sol    Unit tests: happy path + every revert path.
├── X402ReceiptEnforcer.fork.t.sol  Integration test against the real
│                                MetaMask DelegationManager on Base Sepolia.
└── helpers/
    ├── MinimalAccount.sol       60-line smart account stub with EIP-1271 +
    │                            executeFromExecutor. Just enough for the fork
    │                            test to act as a real root delegator.
    └── Constants.sol            Base Sepolia framework addresses + EIP-712
                                 domain separator. Pulled live from the DM.

script/
└── Deploy.s.sol                 Deploys X402ReceiptEnforcer to the configured
                                 network. One line of broadcast.

lib/                             Installed via `forge install` (gitignored):
├── forge-std/                       foundry-rs/forge-std
├── delegation-framework/            MetaMask/delegation-framework
├── erc7579-implementation/          erc7579/erc7579-implementation
└── account-abstraction/             eth-infinitism/account-abstraction
```

## Setup

```bash
# 1. Install Foundry if you don't have it
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Install dependencies
forge install foundry-rs/forge-std --no-commit
forge install MetaMask/delegation-framework --no-commit
forge install erc7579/erc7579-implementation --no-commit
forge install eth-infinitism/account-abstraction --no-commit

# 3. Configure env
cp .env.example .env
# fill in DEPLOYER_PRIVATE_KEY (and BASESCAN_API_KEY if you'll verify)
```

**Why four dependencies for one contract?** The X402ReceiptEnforcer inherits
from `CaveatEnforcer` (in `delegation-framework`), which transitively imports
from `erc7579-implementation` (for `ModeLib`/`ExecutionLib`) and
`account-abstraction` (for `PackedUserOperation` referenced in framework
types). We pin all four explicitly so reproducible builds don't depend on
git submodule recursion.

## Build & test

```bash
# Compile
forge build

# Unit tests (fast, no RPC needed)
forge test --match-contract X402ReceiptEnforcerTest -vvv

# Fork integration test (needs Base Sepolia RPC)
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
forge test --fork-url $BASE_SEPOLIA_RPC_URL \
  --match-contract X402ReceiptEnforcerForkTest -vvv

# Everything
forge test -vvv
```

Expected: all green.

## Deploy

```bash
source .env

forge script script/Deploy.s.sol:Deploy \
  --rpc-url base_sepolia \
  --broadcast \
  --verify \
  -vvv
```

Without `--verify`, the contract deploys but won't be verified on BaseScan.

After deploy, record the address:

```bash
# Address shows up in the broadcast log
cat broadcast/Deploy.s.sol/84532/run-latest.json | jq '.transactions[0].contractAddress'
```

## Live framework addresses (Base Sepolia, v1.3.0)

Pulled from `@metamask/delegation-deployments`. Hardcoded into
[test/helpers/Constants.sol](test/helpers/Constants.sol).

| Contract | Address |
|---|---|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| IdEnforcer | `0xC8B5D93463c893401094cc70e66A206fb5987997` |
| ERC20PeriodTransferEnforcer | `0x474e3Ae7E169e940607cC624Da8A15Eb120139aB` |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| DM EIP-712 domain separator | `0xe71b8491d8c286677a45fed98624307811de12477341393c8399d0e58648242f` |

## Notes for the next maintainer

- The on-chain `redeemDelegations` in v1.3.0 returns no data. If you ever
  re-add a `bool[]` return type to its interface, Solidity will revert at
  the call site trying to decode empty bytes. See the fork test's
  `IDelegationManager` interface for the correct shape.
- `ROOT_AUTHORITY` is `bytes32(type(uint256).max)` (all `0xff`). Not zero.
- Chain encoding for `redeemDelegations` is `[leaf, …, root]`. Not `[root,
  …, leaf]`.
- Caveat enforcer hooks see the *immediate* delegator of the delegation
  carrying the caveat, not the chain's root delegator.

These four cost about four hours combined the first time. Saving them here.

— Conduit
