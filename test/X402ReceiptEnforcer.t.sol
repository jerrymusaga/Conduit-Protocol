// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { X402ReceiptEnforcer, IERC20 } from "../src/X402ReceiptEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

/**
 * @notice Unit tests for X402ReceiptEnforcer in isolation. No fork, no
 *         framework, no real DelegationManager. Just call the enforcer
 *         directly with crafted terms + executionCallData and verify it
 *         accepts or rejects per its rules.
 *
 *         Coverage targets:
 *           - Happy path (event emitted, no revert)
 *           - getTermsInfo round-trip
 *           - Every documented invariant has a dedicated revert test
 *           - Mode modifiers reject wrong call type and wrong exec type
 */
contract X402ReceiptEnforcerTest is Test {
    X402ReceiptEnforcer internal enforcer;

    // Test fixtures
    bytes32 internal constant INTENT_HASH = keccak256("intent-x402-unit-test");
    address internal constant TOKEN     = address(0xDEAD0000000000000000000000000000000000DE);
    address internal constant RECIPIENT = address(0xBEEF0000000000000000000000000000000000EF);
    uint128 internal constant MAX_AMOUNT = 10_000; // 0.01 USDC-ish
    uint8   internal constant FLAGS = 0;

    // Default-exec, single-call mode (both high-order bytes zero per ERC-7579)
    ModeCode internal constant ZERO_MODE = ModeCode.wrap(bytes32(0));
    // Mode with non-zero call-type byte (any value but 0x00 in byte 0)
    ModeCode internal constant BATCH_MODE = ModeCode.wrap(bytes32(uint256(1) << 248));
    // Mode with non-zero exec-type byte (byte 1 == 0x01)
    ModeCode internal constant TRY_MODE   = ModeCode.wrap(bytes32(uint256(1) << 240));

    function setUp() public {
        enforcer = new X402ReceiptEnforcer();
    }

    // ----------------------------------------------------------------
    // Happy path
    // ----------------------------------------------------------------

    function test_BeforeHook_EmitsX402IntentSettled_OnValidRedemption() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, uint256(MAX_AMOUNT));
        bytes32 dHash      = keccak256("test-delegation-hash");
        address delegator  = address(0xC0DE);
        address redeemer   = address(0xC0FFEE);

        vm.expectEmit(true, true, true, true, address(enforcer));
        emit X402ReceiptEnforcer.X402IntentSettled(
            address(this),  // msg.sender in this call IS this contract
            delegator,
            RECIPIENT,
            INTENT_HASH,
            MAX_AMOUNT,
            TOKEN,
            dHash
        );

        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, delegator, redeemer);
    }

    function test_BeforeHook_AcceptsAmountStrictlyBelowCap() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        // Use MAX_AMOUNT - 1 to exercise the `<=` boundary
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, uint256(MAX_AMOUNT) - 1);
        bytes32 dHash      = keccak256("h");

        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2));
    }

    function test_GetTermsInfo_RoundTrips() public view {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        (bytes32 i, address t, address r, uint256 a) = enforcer.getTermsInfo(terms);
        assertEq(i, INTENT_HASH, "intent");
        assertEq(t, TOKEN, "token");
        assertEq(r, RECIPIENT, "recipient");
        assertEq(a, uint256(MAX_AMOUNT), "max");
    }

    // ----------------------------------------------------------------
    // Revert: terms encoding
    // ----------------------------------------------------------------

    function test_RevertsOn_TermsLengthShort() public {
        bytes memory terms = new bytes(88);            // one byte short
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, MAX_AMOUNT);
        vm.expectRevert(bytes("X402Receipt:invalid-terms-length"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_TermsLengthLong() public {
        bytes memory terms = new bytes(90);            // one byte long
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, MAX_AMOUNT);
        vm.expectRevert(bytes("X402Receipt:invalid-terms-length"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    // ----------------------------------------------------------------
    // Revert: execution shape
    // ----------------------------------------------------------------

    function test_RevertsOn_CalldataLengthWrong() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        // Build an execution whose callData is 67 bytes (one short of transfer)
        bytes memory shortCallData = new bytes(67);
        bytes memory exec = abi.encodePacked(TOKEN, uint256(0), shortCallData);

        vm.expectRevert(bytes("X402Receipt:invalid-calldata-length"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_WrongTokenTarget() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        address wrongToken = address(0xBADC0FFEE0DDF00D5BADC0FFEE0DDf00d5BAdC0fe);
        bytes memory exec  = _packTransfer(wrongToken, 0, RECIPIENT, MAX_AMOUNT);

        vm.expectRevert(bytes("X402Receipt:wrong-token"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_NonZeroNativeValue() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        bytes memory exec  = _packTransfer(TOKEN, 1, RECIPIENT, MAX_AMOUNT);

        vm.expectRevert(bytes("X402Receipt:no-native-value-allowed"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_WrongSelector() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        // 4-byte selector for transferFrom, padded the same way as transfer
        bytes4 transferFrom = bytes4(keccak256("transferFrom(address,address,uint256)"));
        // Build a 68-byte calldata that uses the wrong selector
        bytes memory wrongSelectorCalldata = abi.encodePacked(
            transferFrom,
            abi.encode(RECIPIENT, uint256(MAX_AMOUNT))
        );
        bytes memory exec = abi.encodePacked(TOKEN, uint256(0), wrongSelectorCalldata);

        vm.expectRevert(bytes("X402Receipt:not-transfer-selector"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_WrongRecipient() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        address attackerSink = address(0x1111111111111111111111111111111111111111);
        bytes memory exec  = _packTransfer(TOKEN, 0, attackerSink, MAX_AMOUNT);

        vm.expectRevert(bytes("X402Receipt:wrong-recipient"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_AmountExceedsCap() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        // One unit over cap
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, uint256(MAX_AMOUNT) + 1);

        vm.expectRevert(bytes("X402Receipt:amount-exceeds-cap"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, bytes32(0), address(0), address(0));
    }

    // ----------------------------------------------------------------
    // Revert: mode modifiers
    // ----------------------------------------------------------------

    function test_RevertsOn_NonSingleCallTypeMode() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, MAX_AMOUNT);

        vm.expectRevert(bytes("CaveatEnforcer:invalid-call-type"));
        enforcer.beforeHook(terms, "", BATCH_MODE, exec, bytes32(0), address(0), address(0));
    }

    function test_RevertsOn_NonDefaultExecutionMode() public {
        bytes memory terms = _terms(INTENT_HASH, TOKEN, RECIPIENT, MAX_AMOUNT, FLAGS);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, MAX_AMOUNT);

        vm.expectRevert(bytes("CaveatEnforcer:invalid-execution-type"));
        enforcer.beforeHook(terms, "", TRY_MODE, exec, bytes32(0), address(0), address(0));
    }

    // ----------------------------------------------------------------
    // Fuzz: any (intent, token, recipient, amount) within constraints
    //       should pass when the execution matches the terms exactly.
    // ----------------------------------------------------------------
    function testFuzz_HappyPath(
        bytes32 intent,
        address token,
        address recipient,
        uint128 max,
        uint128 amount
    ) public {
        // Constrain to satisfying execution
        vm.assume(token != address(0));
        vm.assume(recipient != address(0));
        vm.assume(amount <= max);

        bytes memory terms = _terms(intent, token, recipient, max, 0);
        bytes memory exec  = _packTransfer(token, 0, recipient, uint256(amount));
        bytes32 dHash      = keccak256(abi.encode(intent, max));

        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2));
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

    function _terms(
        bytes32 intentHash,
        address token,
        address recipient,
        uint128 maxAmount,
        uint8 flags
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(intentHash, token, recipient, maxAmount, flags);
    }

    /// @dev Build an ERC-7579 packed single-call execution that targets
    ///      `token` with `value` ETH and a transfer(to, amount) callData.
    function _packTransfer(
        address token,
        uint256 value,
        address to,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            token,
            value,
            IERC20.transfer.selector,
            abi.encode(to, amount)
        );
    }
}
