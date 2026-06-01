// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

/// @notice Minimal ERC-20 surface used for selector matching (see X402ReceiptEnforcer).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title X402SubscriptionEnforcer
 * @author Conduit
 * @notice Caveat enforcer that binds a delegated ERC-20 transfer to a RECURRING
 *         x402 subscription: pay one fixed amount, to one recipient, in one
 *         token — at most once per period, forever (until the delegation is
 *         revoked or expires).
 *
 * @dev    The sibling of {X402ReceiptEnforcer}. Where the receipt enforcer binds
 *         a SINGLE one-shot payment (pair with IdEnforcer), this binds a
 *         REPEATING one — an agent can renew a subscription each period without
 *         a fresh grant, but can never:
 *           - pay a different recipient,
 *           - pay a different amount,
 *           - pay in a different token,
 *           - or pay twice in the same period (double-charge protection).
 *
 *         Combines the binding of X402ReceiptEnforcer with the period mechanics
 *         of the framework's ERC20PeriodTransferEnforcer — but a subscription is
 *         FIXED-price (exact amount, not "up to"), and exactly one charge per
 *         period (not a cumulative cap), which is the subscription semantic.
 *
 *         Single-call, default-exec only (like its sibling).
 */
contract X402SubscriptionEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (94 bytes, packed):
    //   [ 0:32]  subscriptionId   (bytes32)  off-chain subscription identifier
    //   [32:52]  token            (address)  ERC-20 to pay in
    //   [52:72]  recipient        (address)  the merchant (x402 `payTo`)
    //   [72:88]  amountPerPeriod  (uint128)  exact charge per period, base units
    //   [88:92]  periodDuration   (uint32)   seconds per period
    //   [92:94]  startOffsetUnused (uint16)  reserved (period 0 = first charge)
    // ---------------------------------------------------------------------
    uint256 private constant TERMS_LENGTH = 94;

    // ERC-20 transfer(address,uint256): selector + 32 + 32 = 68 bytes.
    uint256 private constant TRANSFER_CALLDATA_LENGTH = 68;

    /// @notice Per-delegation subscription state: the last period charged.
    ///         period index 0 = "never charged". Keyed like the framework's
    ///         period enforcer: (delegationManager, delegationHash).
    struct SubState {
        uint256 startDate; // timestamp of the first successful charge (anchors periods)
        uint256 lastChargedPeriod; // 1-based period index of the last charge
    }

    mapping(address delegationManager => mapping(bytes32 delegationHash => SubState)) public subscriptions;

    /// @notice Emitted on every successful subscription charge. Off-chain
    ///         indexers correlate `subscriptionId` to the x402 subscription.
    event X402SubscriptionCharged(
        address indexed delegationManager,
        address indexed delegator,
        address indexed recipient,
        bytes32 subscriptionId,
        uint256 amount,
        address token,
        uint256 period,
        bytes32 delegationHash
    );

    // ---------------------------------------------------------------------
    // beforeHook: the recurring-payment safety property lives here.
    //
    // Invariants on the attempted execution:
    //   1. Single-call, default-exec mode.
    //   2. callData is exactly IERC20.transfer(address,uint256).
    //   3. target == bound token; value == 0.
    //   4. to == bound recipient.
    //   5. amount == bound amountPerPeriod  (EXACT — subscriptions are fixed).
    //   6. the current period has not already been charged (no double-charge).
    // ---------------------------------------------------------------------
    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args — unused
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer — unconstrained at this hop
    )
        public
        override
        onlySingleCallTypeMode(_mode)
        onlyDefaultExecutionMode(_mode)
    {
        (
            bytes32 subscriptionId,
            address token,
            address recipient,
            uint256 amountPerPeriod,
            uint256 periodDuration
        ) = getTermsInfo(_terms);

        (address target, uint256 value, bytes calldata callData) =
            _executionCallData.decodeSingle();

        // Length-check FIRST (post-audit ordering, see X402ReceiptEnforcer).
        require(callData.length == TRANSFER_CALLDATA_LENGTH, "X402Sub:invalid-calldata-length");
        require(target == token, "X402Sub:wrong-token");
        require(value == 0, "X402Sub:no-native-value-allowed");
        require(bytes4(callData[0:4]) == IERC20.transfer.selector, "X402Sub:not-transfer-selector");

        (address to, uint256 amount) = abi.decode(callData[4:], (address, uint256));
        require(to == recipient, "X402Sub:wrong-recipient");
        require(amount == amountPerPeriod, "X402Sub:wrong-amount");

        // --- period accounting (double-charge protection) ----------------
        SubState storage sub = subscriptions[msg.sender][_delegationHash];

        uint256 currentPeriod;
        if (sub.startDate == 0) {
            // First charge anchors the schedule; this is period 1.
            sub.startDate = block.timestamp;
            currentPeriod = 1;
        } else {
            currentPeriod = (block.timestamp - sub.startDate) / periodDuration + 1;
        }

        require(sub.lastChargedPeriod < currentPeriod, "X402Sub:already-charged-this-period");
        sub.lastChargedPeriod = currentPeriod;

        emit X402SubscriptionCharged(
            msg.sender, _delegator, to, subscriptionId, amount, token, currentPeriod, _delegationHash
        );
    }

    // ---------------------------------------------------------------------
    // Pure terms decoder. Public so coordinators can introspect a
    // subscription redelegation before handing it out.
    // ---------------------------------------------------------------------
    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (
            bytes32 subscriptionId,
            address token,
            address recipient,
            uint256 amountPerPeriod,
            uint256 periodDuration
        )
    {
        require(_terms.length == TERMS_LENGTH, "X402Sub:invalid-terms-length");

        subscriptionId = bytes32(_terms[0:32]);
        token = address(bytes20(_terms[32:52]));
        recipient = address(bytes20(_terms[52:72]));
        amountPerPeriod = uint256(uint128(bytes16(_terms[72:88])));
        periodDuration = uint256(uint32(bytes4(_terms[88:92])));
        require(periodDuration > 0, "X402Sub:invalid-zero-period");
    }
}
