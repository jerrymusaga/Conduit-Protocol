// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

/// @notice The exact Uniswap v3 SwapRouter02 surface this enforcer binds. The
///         guarded execution is a single call to `exactInputSingle`. SwapRouter02
///         (the deadline-less variant) is deployed at the same address family on
///         Base mainnet (0x2626664c2603336E57B271c5C0b26F421741e481) and Base
///         Sepolia — so the same flow works on testnet and mainnet unchanged.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title SwapBoundsEnforcer
 * @author Conduit
 * @notice Caveat enforcer that binds a delegated DEX swap to safe, pre-authorised
 *         bounds. A redelegation carrying this enforcer can only ever execute ONE
 *         kind of swap on Uniswap v3 — a fixed token pair, on one approved router,
 *         spending at most `maxAmountIn`, demanding at least `minAmountOut`
 *         (a slippage floor), with the output paid to one pinned recipient (the
 *         user). Everything else reverts before the swap executes.
 *
 *         This is the trading sibling of {X402ReceiptEnforcer}: where the receipt
 *         enforcer bounds a payment (one ERC-20 transfer), this bounds a swap
 *         (one Uniswap `exactInputSingle` call). It lets a coordinator hand a
 *         TRADING agent authority it cannot abuse — a hijacked agent can't swap to
 *         a different (rug) token, can't overspend the cap, can't accept a worse
 *         fill than the floor, and can't redirect the proceeds to itself.
 *
 * @dev    Intent here comes from the USER's grant (the swap bounds), not a seller's
 *         x402 (a swap has no seller). A coordinator may NARROW these bounds in a
 *         child redelegation but the Delegation Manager's caveat-chain walking
 *         means it can never widen them. The account must approve the router for
 *         `tokenIn` (Uniswap pulls via transferFrom) — that standing approval is
 *         safe because the router only ever moves the funds of the account that
 *         CALLS it, and every such call from the user is gated by this enforcer.
 *
 *         Single-call, default-exec only. `fee` (pool tier) and `sqrtPriceLimit`
 *         are left to the agent — they affect routing/price-protection but cannot
 *         widen the pair/cap/floor/recipient guarantees this enforces.
 */
contract SwapBoundsEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (112 bytes, packed):
    //   [  0: 20]  router        (address)   only allowed Uniswap router
    //   [ 20: 40]  tokenIn       (address)   token the agent may sell
    //   [ 40: 60]  tokenOut      (address)   token the agent may buy
    //   [ 60: 76]  maxAmountIn   (uint128)   spend cap, tokenIn base units
    //   [ 76: 92]  minAmountOut  (uint128)   slippage floor, tokenOut base units
    //   [ 92:112]  recipient     (address)   who must receive the output (user)
    // ---------------------------------------------------------------------
    uint256 private constant TERMS_LENGTH = 112;

    // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)):
    // a single all-static tuple is encoded inline, so calldata is
    //   selector(4) + 7 * 32 = 228 bytes.
    uint256 private constant SWAP_CALLDATA_LENGTH = 228;

    /// @notice Emitted when a bounded swap is redeemed under this enforcer — the
    ///         on-chain receipt of an agent trade the user pre-authorised.
    event SwapBounded(
        address indexed delegationManager,
        address indexed delegator,
        address indexed recipient,
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes32 delegationHash
    );

    // ---------------------------------------------------------------------
    // beforeHook: the safety property. Called by the Delegation Manager BEFORE
    // the swap executes; reverting cancels the whole redemption.
    //
    // Invariants on the swap being attempted:
    //   1. Single-call, default-exec mode.
    //   2. target == the approved router in `_terms`.
    //   3. value (native ETH) == 0.
    //   4. callData is exactly an exactInputSingle(...) call.
    //   5. tokenIn / tokenOut == the pinned pair.
    //   6. amountIn <= maxAmountIn (spend cap).
    //   7. amountOutMinimum requested >= the floor in `_terms` (no bad fill).
    //   8. recipient == the pinned recipient (no redirect of proceeds).
    // ---------------------------------------------------------------------
    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args -- unused
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer -- unconstrained at this hop
    ) public override onlySingleCallTypeMode(_mode) onlyDefaultExecutionMode(_mode) {
        (
            address router,
            address tokenIn,
            address tokenOut,
            uint256 maxAmountIn,
            uint256 minAmountOut,
            address recipient
        ) = getTermsInfo(_terms);

        (address target, uint256 value, bytes calldata callData) = _executionCallData.decodeSingle();

        // Length-check FIRST (post-audit ordering, mirrors X402ReceiptEnforcer).
        require(callData.length == SWAP_CALLDATA_LENGTH, "SwapBounds:invalid-calldata-length");

        require(target == router, "SwapBounds:wrong-router");
        require(value == 0, "SwapBounds:no-native-value-allowed");
        require(bytes4(callData[0:4]) == ISwapRouter02.exactInputSingle.selector, "SwapBounds:not-swap-selector");

        // Decode the inlined ExactInputSingleParams tuple. The length check
        // guarantees exactly 7 words (224 bytes) of args after the selector.
        (
            address callTokenIn,
            address callTokenOut,, // uint24 fee -- agent's choice of pool tier
            address callRecipient,
            uint256 amountIn,
            uint256 callMinOut,
            // uint160 sqrtPriceLimitX96 -- agent's choice
        ) = abi.decode(callData[4:], (address, address, uint24, address, uint256, uint256, uint160));

        require(callTokenIn == tokenIn, "SwapBounds:wrong-token-in");
        require(callTokenOut == tokenOut, "SwapBounds:wrong-token-out");
        require(amountIn <= maxAmountIn, "SwapBounds:amount-exceeds-cap");
        // The agent must demand AT LEAST the floor — it can't accept a worse fill.
        require(callMinOut >= minAmountOut, "SwapBounds:min-out-too-low");
        require(callRecipient == recipient, "SwapBounds:wrong-recipient");

        emit SwapBounded(
            msg.sender, // DelegationManager
            _delegator,
            recipient,
            router,
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOut,
            _delegationHash
        );
    }

    // ---------------------------------------------------------------------
    // Pure terms decoder. Public so a coordinator can introspect a swap
    // redelegation before handing it out and confirm the bounds match the
    // trade the user authorised.
    // ---------------------------------------------------------------------
    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (
            address router,
            address tokenIn,
            address tokenOut,
            uint256 maxAmountIn,
            uint256 minAmountOut,
            address recipient
        )
    {
        require(_terms.length == TERMS_LENGTH, "SwapBounds:invalid-terms-length");

        router = address(bytes20(_terms[0:20]));
        tokenIn = address(bytes20(_terms[20:40]));
        tokenOut = address(bytes20(_terms[40:60]));
        maxAmountIn = uint256(uint128(bytes16(_terms[60:76])));
        minAmountOut = uint256(uint128(bytes16(_terms[76:92])));
        recipient = address(bytes20(_terms[92:112]));
    }
}
