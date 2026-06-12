// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { SwapAllowlistEnforcer } from "../src/SwapAllowlistEnforcer.sol";
import { ISwapRouter02 } from "../src/SwapBoundsEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

/**
 * @notice Unit coverage for SwapAllowlistEnforcer: a swap into ANY token in the
 *         signed allowlist (each with its own slippage floor) is allowed; a token
 *         OUTSIDE the set, or any other deviation, reverts before execution.
 */
contract SwapAllowlistEnforcerTest is Test {
    SwapAllowlistEnforcer internal enforcer;

    address internal router = makeAddr("uniswapRouter");
    address internal usdc = makeAddr("USDC");
    address internal weth = makeAddr("WETH"); // allowed #1
    address internal cbeth = makeAddr("cbETH"); // allowed #2
    address internal rug = makeAddr("rugToken"); // NOT allowed
    address internal user = makeAddr("user");
    address internal attacker = makeAddr("attacker");
    address internal delegator = makeAddr("delegator");

    uint128 internal constant MAX_IN = 20_000_000; // 20 USDC
    uint128 internal constant WETH_FLOOR = 5_000_000_000_000_000; // 0.005 WETH
    uint128 internal constant CBETH_FLOOR = 4_000_000_000_000_000; // 0.004 cbETH

    ModeCode internal constant SINGLE_DEFAULT = ModeCode.wrap(bytes32(0));
    bytes32 internal constant DHASH = keccak256("swap-allow");

    function setUp() public {
        enforcer = new SwapAllowlistEnforcer();
    }

    // router · tokenIn · maxIn · recipient · N · [tokenOut·minOut]×N
    function _terms() internal view returns (bytes memory) {
        return abi.encodePacked(router, usdc, MAX_IN, user, uint8(2), weth, WETH_FLOOR, cbeth, CBETH_FLOOR);
    }

    function _params(address tokenOut, uint256 minOut)
        internal
        view
        returns (ISwapRouter02.ExactInputSingleParams memory)
    {
        return ISwapRouter02.ExactInputSingleParams({
            tokenIn: usdc,
            tokenOut: tokenOut,
            fee: 500,
            recipient: user,
            amountIn: MAX_IN,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
    }

    function _exec(address target, uint256 value, ISwapRouter02.ExactInputSingleParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(target, value, abi.encodeCall(ISwapRouter02.exactInputSingle, (p)));
    }

    function _run(bytes memory terms, bytes memory exec) internal {
        enforcer.beforeHook(terms, "", SINGLE_DEFAULT, exec, DHASH, delegator, address(0));
    }

    // ---- allowed: either token in the set, at/above its own floor ----
    function test_AllowsFirstAllowlistToken() public {
        _run(_terms(), _exec(router, 0, _params(weth, WETH_FLOOR)));
    }

    function test_AllowsSecondAllowlistToken() public {
        _run(_terms(), _exec(router, 0, _params(cbeth, CBETH_FLOOR)));
    }

    function test_AllowsAboveFloor() public {
        _run(_terms(), _exec(router, 0, _params(cbeth, uint256(CBETH_FLOOR) + 1e15)));
    }

    // ---- rogue rejections ----
    function test_RevertsTokenNotInAllowlist() public {
        vm.expectRevert(bytes("SwapAllow:token-not-allowed"));
        _run(_terms(), _exec(router, 0, _params(rug, 1)));
    }

    function test_RevertsMinOutBelowThatTokensFloor() public {
        // cbETH is allowed, but below ITS floor.
        vm.expectRevert(bytes("SwapAllow:min-out-too-low"));
        _run(_terms(), _exec(router, 0, _params(cbeth, uint256(CBETH_FLOOR) - 1)));
    }

    function test_RevertsWrongRecipient() public {
        ISwapRouter02.ExactInputSingleParams memory p = _params(weth, WETH_FLOOR);
        p.recipient = attacker;
        vm.expectRevert(bytes("SwapAllow:wrong-recipient"));
        _run(_terms(), _exec(router, 0, p));
    }

    function test_RevertsOverCap() public {
        ISwapRouter02.ExactInputSingleParams memory p = _params(weth, WETH_FLOOR);
        p.amountIn = uint256(MAX_IN) + 1;
        vm.expectRevert(bytes("SwapAllow:amount-exceeds-cap"));
        _run(_terms(), _exec(router, 0, p));
    }

    function test_RevertsWrongTokenIn() public {
        ISwapRouter02.ExactInputSingleParams memory p = _params(weth, WETH_FLOOR);
        p.tokenIn = rug;
        vm.expectRevert(bytes("SwapAllow:wrong-token-in"));
        _run(_terms(), _exec(router, 0, p));
    }

    function test_RevertsWrongRouter() public {
        vm.expectRevert(bytes("SwapAllow:wrong-router"));
        _run(_terms(), _exec(makeAddr("evil"), 0, _params(weth, WETH_FLOOR)));
    }

    function test_RevertsNativeValue() public {
        vm.expectRevert(bytes("SwapAllow:no-native-value-allowed"));
        _run(_terms(), _exec(router, 1, _params(weth, WETH_FLOOR)));
    }

    function test_GetTermsInfoRoundTrips() public view {
        (address r, address tin, uint256 cap, address rec, address[] memory outs, uint256[] memory mins) =
            enforcer.getTermsInfo(_terms());
        assertEq(r, router);
        assertEq(tin, usdc);
        assertEq(cap, MAX_IN);
        assertEq(rec, user);
        assertEq(outs.length, 2);
        assertEq(outs[0], weth);
        assertEq(mins[1], CBETH_FLOOR);
    }
}
