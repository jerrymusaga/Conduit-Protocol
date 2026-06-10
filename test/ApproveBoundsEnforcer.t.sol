// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { ApproveBoundsEnforcer } from "../src/ApproveBoundsEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @notice Unit coverage for ApproveBoundsEnforcer: a capped approval to the swap
 *         router is allowed, and every deviation (wrong token, wrong spender,
 *         over cap, non-approve calldata, native value) reverts before execution.
 */
contract ApproveBoundsEnforcerTest is Test {
    ApproveBoundsEnforcer internal enforcer;

    address internal token    = makeAddr("USDC");
    address internal router    = makeAddr("uniswapRouter");
    address internal attacker  = makeAddr("attacker");
    address internal delegator = makeAddr("delegator");

    uint128 internal constant CAP = 20_000_000; // 20 USDC
    ModeCode internal constant SINGLE_DEFAULT = ModeCode.wrap(bytes32(0));
    bytes32 internal constant DHASH = keccak256("approve-delegation");

    function setUp() public {
        enforcer = new ApproveBoundsEnforcer();
    }

    function _terms() internal view returns (bytes memory) {
        return abi.encodePacked(token, router, CAP);
    }

    function _exec(address target, uint256 value, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, callData);
    }

    function _approveCalldata(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20Approve.approve, (spender, amount));
    }

    function _run(bytes memory terms, bytes memory exec) internal {
        enforcer.beforeHook(terms, "", SINGLE_DEFAULT, exec, DHASH, delegator, address(0));
    }

    function test_AllowsCappedApprovalToRouter() public {
        _run(_terms(), _exec(token, 0, _approveCalldata(router, CAP)));
    }

    function test_AllowsBelowCap() public {
        _run(_terms(), _exec(token, 0, _approveCalldata(router, uint256(CAP) - 1)));
    }

    function test_RevertsWrongToken() public {
        vm.expectRevert(bytes("ApproveBounds:wrong-token"));
        _run(_terms(), _exec(makeAddr("rugToken"), 0, _approveCalldata(router, CAP)));
    }

    function test_RevertsWrongSpender() public {
        vm.expectRevert(bytes("ApproveBounds:wrong-spender"));
        _run(_terms(), _exec(token, 0, _approveCalldata(attacker, CAP)));
    }

    function test_RevertsOverCap() public {
        vm.expectRevert(bytes("ApproveBounds:amount-exceeds-cap"));
        _run(_terms(), _exec(token, 0, _approveCalldata(router, uint256(CAP) + 1)));
    }

    function test_RevertsNativeValue() public {
        vm.expectRevert(bytes("ApproveBounds:no-native-value-allowed"));
        _run(_terms(), _exec(token, 1, _approveCalldata(router, CAP)));
    }

    function test_RevertsWrongSelector() public {
        // transfer(address,uint256) — same length, different selector.
        bytes memory wrong = abi.encodeWithSelector(bytes4(0xa9059cbb), router, CAP);
        vm.expectRevert(bytes("ApproveBounds:not-approve-selector"));
        _run(_terms(), _exec(token, 0, wrong));
    }

    function test_RevertsBadCalldataLength() public {
        vm.expectRevert(bytes("ApproveBounds:invalid-calldata-length"));
        _run(_terms(), _exec(token, 0, hex"12345678"));
    }

    function test_RevertsBadTermsLength() public {
        vm.expectRevert(bytes("ApproveBounds:invalid-terms-length"));
        _run(hex"dead", _exec(token, 0, _approveCalldata(router, CAP)));
    }
}
