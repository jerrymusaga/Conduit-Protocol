// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { YieldAllowlistEnforcer, IAavePool } from "../src/YieldAllowlistEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

/**
 * @notice Unit coverage for YieldAllowlistEnforcer: a supply into ANY pool in the
 *         signed venue allowlist (each with its own minimum-deposit floor) is
 *         allowed; a pool OUTSIDE the set, or any other deviation (wrong asset,
 *         over-cap, redirected aTokens, below a venue's floor), reverts before the
 *         deposit executes.
 */
contract YieldAllowlistEnforcerTest is Test {
    YieldAllowlistEnforcer internal enforcer;

    address internal usdc      = makeAddr("USDC");
    address internal aave      = makeAddr("aaveV3Pool");   // allowed venue #1
    address internal seamless  = makeAddr("seamlessPool"); // allowed venue #2
    address internal rugPool   = makeAddr("rugPool");      // NOT allowed
    address internal user      = makeAddr("user");
    address internal attacker  = makeAddr("attacker");
    address internal delegator = makeAddr("delegator");

    uint128 internal constant MAX_IN      = 50_000_000; // 50 USDC
    uint128 internal constant AAVE_FLOOR  = 1_000_000;  // 1 USDC min into Aave
    uint128 internal constant SEAM_FLOOR  = 0;          // no floor for Seamless

    ModeCode internal constant SINGLE_DEFAULT = ModeCode.wrap(bytes32(0));
    bytes32 internal constant DHASH = keccak256("yield-allow");

    function setUp() public {
        enforcer = new YieldAllowlistEnforcer();
    }

    // asset · maxIn · recipient · N · [pool·minAmount]×N
    function _terms() internal view returns (bytes memory) {
        return abi.encodePacked(
            usdc, MAX_IN, user, uint8(2),
            aave, AAVE_FLOOR,
            seamless, SEAM_FLOOR
        );
    }

    function _supply(address asset, uint256 amount, address onBehalfOf) internal pure returns (bytes memory) {
        return abi.encodeCall(IAavePool.supply, (asset, amount, onBehalfOf, 0));
    }

    function _exec(address target, uint256 value, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, callData);
    }

    function _run(bytes memory terms, bytes memory exec) internal {
        enforcer.beforeHook(terms, "", SINGLE_DEFAULT, exec, DHASH, delegator, address(0));
    }

    // ---- allowed: either venue in the set, at/above its own floor ----
    function test_AllowsFirstVenue() public {
        _run(_terms(), _exec(aave, 0, _supply(usdc, AAVE_FLOOR, user)));
    }

    function test_AllowsSecondVenue() public {
        _run(_terms(), _exec(seamless, 0, _supply(usdc, 1, user)));
    }

    function test_AllowsAtCap() public {
        _run(_terms(), _exec(aave, 0, _supply(usdc, MAX_IN, user)));
    }

    // ---- rogue rejections ----
    function test_RevertsVenueNotInAllowlist() public {
        vm.expectRevert(bytes("YieldAllow:venue-not-allowed"));
        _run(_terms(), _exec(rugPool, 0, _supply(usdc, MAX_IN, user)));
    }

    function test_RevertsBelowVenueFloor() public {
        // Aave is allowed, but below ITS minimum-deposit floor.
        vm.expectRevert(bytes("YieldAllow:amount-below-floor"));
        _run(_terms(), _exec(aave, 0, _supply(usdc, uint256(AAVE_FLOOR) - 1, user)));
    }

    function test_RevertsWrongRecipient() public {
        vm.expectRevert(bytes("YieldAllow:wrong-recipient"));
        _run(_terms(), _exec(aave, 0, _supply(usdc, AAVE_FLOOR, attacker)));
    }

    function test_RevertsOverCap() public {
        vm.expectRevert(bytes("YieldAllow:amount-exceeds-cap"));
        _run(_terms(), _exec(aave, 0, _supply(usdc, uint256(MAX_IN) + 1, user)));
    }

    function test_RevertsWrongAsset() public {
        vm.expectRevert(bytes("YieldAllow:wrong-asset"));
        _run(_terms(), _exec(aave, 0, _supply(makeAddr("WETH"), AAVE_FLOOR, user)));
    }

    function test_RevertsNativeValue() public {
        vm.expectRevert(bytes("YieldAllow:no-native-value-allowed"));
        _run(_terms(), _exec(aave, 1, _supply(usdc, AAVE_FLOOR, user)));
    }

    function test_RevertsNotSupplySelector() public {
        // A 132-byte calldata with the wrong selector.
        bytes memory bad = abi.encodePacked(bytes4(0xdeadbeef), uint256(0), uint256(0), uint256(0), uint256(0));
        vm.expectRevert(bytes("YieldAllow:not-supply-selector"));
        _run(_terms(), _exec(aave, 0, bad));
    }

    function test_GetTermsInfoRoundTrips() public view {
        (address asset, uint256 cap, address rec, address[] memory pools, uint256[] memory mins) =
            enforcer.getTermsInfo(_terms());
        assertEq(asset, usdc);
        assertEq(cap, MAX_IN);
        assertEq(rec, user);
        assertEq(pools.length, 2);
        assertEq(pools[0], aave);
        assertEq(pools[1], seamless);
        assertEq(mins[0], AAVE_FLOOR);
        assertEq(mins[1], SEAM_FLOOR);
    }
}
