// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { X402SubscriptionEnforcer } from "../src/X402SubscriptionEnforcer.sol";
import { IERC20 } from "../src/X402ReceiptEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

/**
 * @notice Unit tests for X402SubscriptionEnforcer in isolation. Calls the
 *         enforcer directly with crafted terms + executionCallData.
 *
 *         Coverage:
 *           - Happy path: first charge (period 1) emits + succeeds
 *           - Double-charge in the same period reverts
 *           - A charge in the NEXT period succeeds (after warp)
 *           - Exact-amount binding (wrong amount, over AND under, reverts)
 *           - wrong-recipient / wrong-token / native-value reverts
 *           - getTermsInfo round-trip + zero-period guard
 *           - mode modifiers reject batch / try exec
 */
contract X402SubscriptionEnforcerTest is Test {
    X402SubscriptionEnforcer internal enforcer;

    bytes32 internal constant SUB_ID = keccak256("sub-x402-unit-test");
    address internal constant TOKEN     = address(0xdead000000000000000000000000000000000001);
    address internal constant RECIPIENT = address(0xbeeF000000000000000000000000000000000002);
    uint128 internal constant AMOUNT = 5_000; // fixed price per period
    uint32  internal constant PERIOD = 86_400; // 1 day

    ModeCode internal constant ZERO_MODE  = ModeCode.wrap(bytes32(0));
    ModeCode internal constant BATCH_MODE = ModeCode.wrap(bytes32(uint256(1) << 248));
    ModeCode internal constant TRY_MODE   = ModeCode.wrap(bytes32(uint256(1) << 240));

    function setUp() public {
        enforcer = new X402SubscriptionEnforcer();
        vm.warp(1_000_000); // a sane non-zero start time
    }

    // ----------------------------------------------------------------
    // Happy path + period mechanics
    // ----------------------------------------------------------------

    function test_FirstCharge_Succeeds_AsPeriod1() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, AMOUNT);
        bytes32 dHash = keccak256("d");

        vm.expectEmit(true, true, true, true, address(enforcer));
        emit X402SubscriptionEnforcer.X402SubscriptionCharged(
            address(this), address(0xC0DE), RECIPIENT, SUB_ID, AMOUNT, TOKEN, 1, dHash
        );
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(0xC0DE), address(0xCAFE));
    }

    function test_DoubleCharge_SamePeriod_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, AMOUNT);
        bytes32 dHash = keccak256("d");

        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2));
        // Second charge in the same period must revert.
        vm.expectRevert(bytes("X402Sub:already-charged-this-period"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2));
    }

    function test_Charge_NextPeriod_Succeeds() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, AMOUNT);
        bytes32 dHash = keccak256("d");

        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2)); // period 1
        vm.warp(block.timestamp + PERIOD); // into period 2
        // No revert: a new period allows the next charge.
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, dHash, address(1), address(2));
    }

    // ----------------------------------------------------------------
    // Exact-amount binding (subscriptions are fixed-price)
    // ----------------------------------------------------------------

    function test_OverAmount_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, uint256(AMOUNT) + 1);
        vm.expectRevert(bytes("X402Sub:wrong-amount"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, keccak256("d"), address(1), address(2));
    }

    function test_UnderAmount_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, uint256(AMOUNT) - 1);
        vm.expectRevert(bytes("X402Sub:wrong-amount"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, keccak256("d"), address(1), address(2));
    }

    // ----------------------------------------------------------------
    // Recipient / token / value binding
    // ----------------------------------------------------------------

    function test_WrongRecipient_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, address(0xBAD), AMOUNT);
        vm.expectRevert(bytes("X402Sub:wrong-recipient"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, keccak256("d"), address(1), address(2));
    }

    function test_WrongToken_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(address(0xBAD), 0, RECIPIENT, AMOUNT);
        vm.expectRevert(bytes("X402Sub:wrong-token"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, keccak256("d"), address(1), address(2));
    }

    function test_NativeValue_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 1, RECIPIENT, AMOUNT);
        vm.expectRevert(bytes("X402Sub:no-native-value-allowed"));
        enforcer.beforeHook(terms, "", ZERO_MODE, exec, keccak256("d"), address(1), address(2));
    }

    // ----------------------------------------------------------------
    // Terms decoding + mode modifiers
    // ----------------------------------------------------------------

    function test_GetTermsInfo_RoundTrips() public view {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        (bytes32 id, address t, address r, uint256 amt, uint256 per) = enforcer.getTermsInfo(terms);
        assertEq(id, SUB_ID);
        assertEq(t, TOKEN);
        assertEq(r, RECIPIENT);
        assertEq(amt, AMOUNT);
        assertEq(per, PERIOD);
    }

    function test_InvalidTermsLength_Reverts() public {
        vm.expectRevert(bytes("X402Sub:invalid-terms-length"));
        enforcer.getTermsInfo(hex"deadbeef");
    }

    function test_BatchMode_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, AMOUNT);
        vm.expectRevert();
        enforcer.beforeHook(terms, "", BATCH_MODE, exec, keccak256("d"), address(1), address(2));
    }

    function test_TryExecMode_Reverts() public {
        bytes memory terms = _terms(SUB_ID, TOKEN, RECIPIENT, AMOUNT, PERIOD);
        bytes memory exec  = _packTransfer(TOKEN, 0, RECIPIENT, AMOUNT);
        vm.expectRevert();
        enforcer.beforeHook(terms, "", TRY_MODE, exec, keccak256("d"), address(1), address(2));
    }

    // ----------------------------------------------------------------
    // helpers
    // ----------------------------------------------------------------

    function _terms(
        bytes32 subId,
        address token,
        address recipient,
        uint128 amountPerPeriod,
        uint32 periodDuration
    ) internal pure returns (bytes memory) {
        // 32 + 20 + 20 + 16 + 4 + 2(reserved) = 94 bytes
        return abi.encodePacked(
            subId, token, recipient, amountPerPeriod, periodDuration, uint16(0)
        );
    }

    function _packTransfer(
        address token,
        uint256 value,
        address to,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(token, value, IERC20.transfer.selector, abi.encode(to, amount));
    }
}
