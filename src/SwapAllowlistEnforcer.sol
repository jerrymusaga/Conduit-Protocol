// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";
import { ISwapRouter02 } from "./SwapBoundsEnforcer.sol";

/**
 * @title SwapAllowlistEnforcer
 * @author Conduit
 * @notice The dynamic-token sibling of {SwapBoundsEnforcer}. Instead of pinning a
 *         single output token, the user's signature authorises a curated SET of
 *         output tokens — each with its own slippage floor — so a "scout" agent
 *         can pick the best token from the set and a "trade" agent can swap into
 *         it, WITHOUT the user re-signing. A hijacked agent still cannot swap into
 *         anything outside the approved set, overspend the cap, accept a worse
 *         fill than that token's floor, or redirect the proceeds.
 *
 *         This is what lets "swap USDC into the best token for X" be safe: the
 *         set the agent may choose from is the set YOU signed. Resolving a token
 *         name to an address never gives the agent reach beyond the allowlist.
 *
 * @dev    Guards one Uniswap v3 `exactInputSingle`. Single-call, default-exec only.
 */
contract SwapAllowlistEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (77 + N*36 bytes, packed):
    //   [ 0:20]  router       (address)
    //   [20:40]  tokenIn      (address)
    //   [40:56]  maxAmountIn  (uint128)
    //   [56:76]  recipient    (address)
    //   [76:77]  N            (uint8)     number of allowed output tokens
    //   then N × {  tokenOut (address,20)  ++  minAmountOut (uint128,16)  }
    // ---------------------------------------------------------------------
    uint256 private constant HEADER_LENGTH = 77;
    uint256 private constant ENTRY_LENGTH = 36;
    uint256 private constant SWAP_CALLDATA_LENGTH = 228; // exactInputSingle

    event SwapAllowed(
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

    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer
    ) public override onlySingleCallTypeMode(_mode) onlyDefaultExecutionMode(_mode) {
        // --- header ---
        require(_terms.length >= HEADER_LENGTH, "SwapAllow:invalid-terms-length");
        address router = address(bytes20(_terms[0:20]));
        address tokenIn = address(bytes20(_terms[20:40]));
        uint256 maxAmountIn = uint256(uint128(bytes16(_terms[40:56])));
        address recipient = address(bytes20(_terms[56:76]));
        uint256 n = uint8(_terms[76]);
        require(n > 0 && _terms.length == HEADER_LENGTH + n * ENTRY_LENGTH, "SwapAllow:invalid-terms-length");

        // --- decode the swap ---
        (address target, uint256 value, bytes calldata callData) = _executionCallData.decodeSingle();
        require(callData.length == SWAP_CALLDATA_LENGTH, "SwapAllow:invalid-calldata-length");
        require(target == router, "SwapAllow:wrong-router");
        require(value == 0, "SwapAllow:no-native-value-allowed");
        require(bytes4(callData[0:4]) == ISwapRouter02.exactInputSingle.selector, "SwapAllow:not-swap-selector");

        (
            address callTokenIn,
            address callTokenOut,, // fee
            address callRecipient,
            uint256 amountIn,
            uint256 callMinOut,
            // sqrtPriceLimit
        ) = abi.decode(callData[4:], (address, address, uint24, address, uint256, uint256, uint160));

        require(callTokenIn == tokenIn, "SwapAllow:wrong-token-in");
        require(amountIn <= maxAmountIn, "SwapAllow:amount-exceeds-cap");
        require(callRecipient == recipient, "SwapAllow:wrong-recipient");

        // --- tokenOut must be in the allowlist; enforce ITS floor ---
        uint256 floor;
        bool found;
        for (uint256 i = 0; i < n; i++) {
            uint256 base = HEADER_LENGTH + i * ENTRY_LENGTH;
            if (address(bytes20(_terms[base:base + 20])) == callTokenOut) {
                floor = uint256(uint128(bytes16(_terms[base + 20:base + 36])));
                found = true;
                break;
            }
        }
        require(found, "SwapAllow:token-not-allowed");
        require(callMinOut >= floor, "SwapAllow:min-out-too-low");

        emit SwapAllowed(
            msg.sender, _delegator, recipient, router, tokenIn, callTokenOut, amountIn, floor, _delegationHash
        );
    }

    /// @notice Decode the bounds for off-chain introspection (a coordinator can
    ///         confirm the set + floors before handing out a swap redelegation).
    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (
            address router,
            address tokenIn,
            uint256 maxAmountIn,
            address recipient,
            address[] memory tokensOut,
            uint256[] memory minsOut
        )
    {
        require(_terms.length >= HEADER_LENGTH, "SwapAllow:invalid-terms-length");
        router = address(bytes20(_terms[0:20]));
        tokenIn = address(bytes20(_terms[20:40]));
        maxAmountIn = uint256(uint128(bytes16(_terms[40:56])));
        recipient = address(bytes20(_terms[56:76]));
        uint256 n = uint8(_terms[76]);
        require(n > 0 && _terms.length == HEADER_LENGTH + n * ENTRY_LENGTH, "SwapAllow:invalid-terms-length");

        tokensOut = new address[](n);
        minsOut = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 base = HEADER_LENGTH + i * ENTRY_LENGTH;
            tokensOut[i] = address(bytes20(_terms[base:base + 20]));
            minsOut[i] = uint256(uint128(bytes16(_terms[base + 20:base + 36])));
        }
    }
}
