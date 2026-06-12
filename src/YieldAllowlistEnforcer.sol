// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

/// @notice The exact Aave-V3 `Pool` surface this enforcer binds. The guarded
///         execution is a single `supply` — deposit `amount` of `asset` into a
///         lending pool, crediting the interest-bearing aTokens to `onBehalfOf`.
///         Aave V3 and its address-compatible forks on Base (Seamless, ZeroLend,
///         Aave's own market) all expose this exact signature, so one enforcer
///         covers a whole set of venues without per-venue special-casing.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

/**
 * @title YieldAllowlistEnforcer
 * @author Conduit
 * @notice The yield-deposit sibling of {SwapAllowlistEnforcer}. Where the swap
 *         allowlist lets a scout pick the best TOKEN from a signed set, this lets a
 *         scout pick the best VENUE (the highest APY) from a signed set of lending
 *         pools and a "deposit" agent supply into it — WITHOUT the user re-signing.
 *
 *         The user's signature authorises a curated SET of yield venues, each with
 *         its own minimum-deposit floor, for ONE asset, up to ONE spend cap, with
 *         the interest-bearing position credited to ONE pinned recipient (the user).
 *         A hijacked agent still cannot supply into a venue you didn't approve,
 *         overspend the cap, supply a different asset, or redirect the aTokens
 *         (the yield) to itself — every deviation reverts before the deposit runs.
 *
 *         This is what makes "move my USDC into the best yield" safe: the venues the
 *         agent may choose from are the venues YOU signed. Resolving "best APY" off
 *         chain never gives the agent reach beyond the allowlist.
 *
 * @dev    Intent here comes from the USER's grant (the venue set), not a seller's
 *         x402 (a deposit has no seller). A coordinator may NARROW the set in a
 *         child redelegation but the Delegation Manager's caveat-chain walking means
 *         it can never widen it. The account must approve the chosen pool for
 *         `asset` (the pool pulls via transferFrom) — that allowance rides the same
 *         1Shot batch via {ApproveBoundsEnforcer}, so the user never needs ETH.
 *
 *         Single-call, default-exec only. `referralCode` is left to the agent — it
 *         affects nothing this enforces.
 */
contract YieldAllowlistEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (57 + N*36 bytes, packed):
    //   [ 0:20]  asset        (address)   the ERC-20 the agent may supply (USDC)
    //   [20:36]  maxAmountIn  (uint128)   spend cap, asset base units
    //   [36:56]  recipient    (address)   onBehalfOf — who receives the aTokens (user)
    //   [56:57]  N            (uint8)     number of allowed venues
    //   then N × {  pool (address,20)  ++  minAmount (uint128,16)  }
    // ---------------------------------------------------------------------
    uint256 private constant HEADER_LENGTH = 57;
    uint256 private constant ENTRY_LENGTH = 36;

    // supply(address,uint256,address,uint16): selector(4) + 4 * 32 = 132 bytes.
    uint256 private constant SUPPLY_CALLDATA_LENGTH = 132;

    /// @notice Emitted when a bounded deposit is redeemed under this enforcer — the
    ///         on-chain receipt of an agent yield-deposit the user pre-authorised.
    event YieldAllowed(
        address indexed delegationManager,
        address indexed delegator,
        address indexed recipient,
        address pool,
        address asset,
        uint256 amount,
        uint256 minAmount,
        bytes32 delegationHash
    );

    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args -- unused
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer -- unconstrained at this hop
    ) public override onlySingleCallTypeMode(_mode) onlyDefaultExecutionMode(_mode) {
        // --- header ---
        require(_terms.length >= HEADER_LENGTH, "YieldAllow:invalid-terms-length");
        address asset = address(bytes20(_terms[0:20]));
        uint256 maxAmountIn = uint256(uint128(bytes16(_terms[20:36])));
        address recipient = address(bytes20(_terms[36:56]));
        uint256 n = uint8(_terms[56]);
        require(n > 0 && _terms.length == HEADER_LENGTH + n * ENTRY_LENGTH, "YieldAllow:invalid-terms-length");

        // --- decode the deposit ---
        (address target, uint256 value, bytes calldata callData) = _executionCallData.decodeSingle();
        require(callData.length == SUPPLY_CALLDATA_LENGTH, "YieldAllow:invalid-calldata-length");
        require(value == 0, "YieldAllow:no-native-value-allowed");
        require(bytes4(callData[0:4]) == IAavePool.supply.selector, "YieldAllow:not-supply-selector");

        (
            address callAsset,
            uint256 amount,
            address callOnBehalfOf,
            // uint16 referralCode -- agent's choice, affects nothing enforced
        ) = abi.decode(callData[4:], (address, uint256, address, uint16));

        require(callAsset == asset, "YieldAllow:wrong-asset");
        require(amount <= maxAmountIn, "YieldAllow:amount-exceeds-cap");
        require(callOnBehalfOf == recipient, "YieldAllow:wrong-recipient");

        // --- target pool must be in the allowlist; enforce ITS minimum-deposit floor ---
        uint256 floor;
        bool found;
        for (uint256 i = 0; i < n; i++) {
            uint256 base = HEADER_LENGTH + i * ENTRY_LENGTH;
            if (address(bytes20(_terms[base:base + 20])) == target) {
                floor = uint256(uint128(bytes16(_terms[base + 20:base + 36])));
                found = true;
                break;
            }
        }
        require(found, "YieldAllow:venue-not-allowed");
        require(amount >= floor, "YieldAllow:amount-below-floor");

        emit YieldAllowed(msg.sender, _delegator, recipient, target, asset, amount, floor, _delegationHash);
    }

    /// @notice Decode the bounds for off-chain introspection (a coordinator can
    ///         confirm the venue set + floors before handing out a deposit
    ///         redelegation, and a scout can confirm its pick is in-set).
    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (
            address asset,
            uint256 maxAmountIn,
            address recipient,
            address[] memory pools,
            uint256[] memory minAmounts
        )
    {
        require(_terms.length >= HEADER_LENGTH, "YieldAllow:invalid-terms-length");
        asset = address(bytes20(_terms[0:20]));
        maxAmountIn = uint256(uint128(bytes16(_terms[20:36])));
        recipient = address(bytes20(_terms[36:56]));
        uint256 n = uint8(_terms[56]);
        require(n > 0 && _terms.length == HEADER_LENGTH + n * ENTRY_LENGTH, "YieldAllow:invalid-terms-length");

        pools = new address[](n);
        minAmounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 base = HEADER_LENGTH + i * ENTRY_LENGTH;
            pools[i] = address(bytes20(_terms[base:base + 20]));
            minAmounts[i] = uint256(uint128(bytes16(_terms[base + 20:base + 36])));
        }
    }
}
