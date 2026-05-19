// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

/// @notice Minimal ERC-20 surface used for selector matching. We keep this
///         local rather than pulling in OpenZeppelin's IERC20 — the enforcer
///         only needs the selector, not any helpers, and avoiding the dep
///         keeps the build footprint small.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title X402ReceiptEnforcer
 * @author Conduit
 * @notice Caveat enforcer that binds a delegated ERC-20 transfer to a specific
 *         x402 payment intent. A redelegation that carries this enforcer can
 *         only ever be redeemed to pay one recipient, one amount, of one
 *         token, for one declared x402 request — making redelegated agent
 *         budgets safe to compose into multi-hop agent workflows.
 *
 * @dev    Designed to sit on the *redelegation* hop of a chain rooted in a
 *         MetaMask Advanced Permissions (ERC-7715) erc20-token-periodic
 *         grant. The root delegation's period cap and target restriction
 *         continue to enforce via the Delegation Manager's caveat chain
 *         walking; this enforcer adds per-call binding on top.
 *
 *         Pair with `IdEnforcer` (built-in) using `uint256(intentHash)` as
 *         the id for one-shot replay protection. We deliberately do NOT
 *         duplicate id tracking here so behaviour stays composable and the
 *         framework's audited replay-protection path is reused.
 *
 *         This enforcer only validates SINGLE-call, DEFAULT-exec redemptions.
 *         Batch redemptions must be expressed as multiple single-call
 *         redelegations, each with its own intent binding.
 */
contract X402ReceiptEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (89 bytes, packed):
    //   [ 0:32]  intentHash         (bytes32)  x402 PaymentRequirements hash
    //   [32:52]  expectedToken      (address)  ERC-20 the buyer must pay in
    //   [52:72]  expectedRecipient  (address)  Seller address (x402 `payTo`)
    //   [72:88]  maxAmount          (uint128)  Cap, in token base units
    //   [88:89]  flags              (uint8)    Bit 0: anchor on-chain via afterHook (reserved)
    // ---------------------------------------------------------------------
    uint256 private constant TERMS_LENGTH = 89;

    // ERC-20 transfer(address,uint256): selector + 32 (address) + 32 (uint256) = 68 bytes
    uint256 private constant TRANSFER_CALLDATA_LENGTH = 68;

    /// @notice Emitted when a redelegation is redeemed under this enforcer.
    ///         Off-chain indexers correlate `intentHash` to the x402 request
    ///         that authorised the spend, producing the audit chain
    ///         (x402 request → on-chain settlement) the protocol promises.
    event X402IntentSettled(
        address indexed delegationManager,
        address indexed delegator,
        address indexed recipient,
        bytes32 intentHash,
        uint256 amount,
        address token,
        bytes32 delegationHash
    );

    // ---------------------------------------------------------------------
    // beforeHook: the safety property lives here.
    // ---------------------------------------------------------------------
    //
    // We are called by the Delegation Manager BEFORE the underlying execution
    // (the ERC-20 transfer) is performed. Reverting here cancels the entire
    // redemption, including any sibling caveats' state mutations.
    //
    // Required invariants on the execution being attempted:
    //   1. Single-call, default-exec mode.
    //   2. Target == the token specified in `_terms`.
    //   3. value (native ETH) == 0.
    //   4. callData is exactly an `IERC20.transfer(address,uint256)` call.
    //   5. transfer's `to` == the recipient pinned in `_terms`.
    //   6. transfer's `amount` <= `maxAmount` in `_terms`.
    //
    // Combined with `IdEnforcer(uint256(intentHash))` on the same redelegation,
    // this gives single-use, fully-bound payment.
    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args -- unused
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer -- intentionally unconstrained at this hop
    )
        public
        override
        onlySingleCallTypeMode(_mode)
        onlyDefaultExecutionMode(_mode)
    {
        (
            bytes32 intentHash,
            address expectedToken,
            address expectedRecipient,
            uint256 maxAmount
        ) = getTermsInfo(_terms);

        (address target, uint256 value, bytes calldata callData) =
            _executionCallData.decodeSingle();

        // Length-check FIRST. The Consensys audit (October 2024) flagged the
        // inverse ordering as a bug in ERC721TransferEnforcer; we mirror the
        // post-audit pattern from ERC20TransferAmountEnforcer here.
        require(
            callData.length == TRANSFER_CALLDATA_LENGTH,
            "X402Receipt:invalid-calldata-length"
        );

        require(target == expectedToken, "X402Receipt:wrong-token");
        require(value == 0, "X402Receipt:no-native-value-allowed");
        require(
            bytes4(callData[0:4]) == IERC20.transfer.selector,
            "X402Receipt:not-transfer-selector"
        );

        // Decode (to, amount) from the transfer calldata.
        // abi.decode is safe here because the length check above guarantees
        // exactly 64 bytes of args after the 4-byte selector.
        (address to, uint256 amount) = abi.decode(callData[4:], (address, uint256));

        require(to == expectedRecipient, "X402Receipt:wrong-recipient");
        require(amount <= maxAmount, "X402Receipt:amount-exceeds-cap");

        // The redemption is allowed to proceed. We emit on the beforeHook
        // rather than afterHook so the event ordering in a multi-caveat
        // redemption is deterministic regardless of caveat order; afterHook
        // execution order can vary in batch/multi-chain redemptions.
        emit X402IntentSettled(
            msg.sender, // DelegationManager
            _delegator,
            to,
            intentHash,
            amount,
            target,
            _delegationHash
        );
    }

    // ---------------------------------------------------------------------
    // Pure terms decoder. Exposed publicly to make off-chain tooling and
    // delegate-side validation simple: a coordinator can introspect a
    // redelegation it's about to hand out and verify it matches the x402
    // request it intends to authorise.
    // ---------------------------------------------------------------------
    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (
            bytes32 intentHash,
            address expectedToken,
            address expectedRecipient,
            uint256 maxAmount
        )
    {
        require(_terms.length == TERMS_LENGTH, "X402Receipt:invalid-terms-length");

        intentHash        = bytes32(_terms[0:32]);
        expectedToken     = address(bytes20(_terms[32:52]));
        expectedRecipient = address(bytes20(_terms[52:72]));
        // Pack maxAmount as uint128 (16 bytes). USDC has 6 decimals so
        // 2^128 wei-units is ~3.4e32 USDC -- more than enough headroom and
        // saves 16 bytes per delegation.
        maxAmount         = uint256(uint128(bytes16(_terms[72:88])));

        // Flags byte at _terms[88] is reserved for future use (e.g. requiring
        // on-chain x402 settlement event anchoring in afterHook). We don't
        // gate on it today; an unknown flag must not change behaviour.
    }
}
