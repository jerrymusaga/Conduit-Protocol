// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test, Vm } from "forge-std/Test.sol";
import { SwapBoundsEnforcer, ISwapRouter02 } from "../src/SwapBoundsEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";

/**
 * @notice Unit coverage for the SwapBoundsEnforcer safety property: a bounded
 *         swap is allowed, and EVERY way a hijacked trading agent might deviate
 *         (wrong router, wrong pair, over cap, bad fill, redirected proceeds,
 *         non-swap calldata, native value) reverts before execution.
 *
 *         Drives beforeHook directly with crafted execution calldata — no chain
 *         needed, so the safety logic is pinned precisely and deterministically.
 */
contract SwapBoundsEnforcerTest is Test {
    SwapBoundsEnforcer internal enforcer;

    address internal router    = makeAddr("uniswapRouter");
    address internal tokenIn   = makeAddr("USDC");
    address internal tokenOut  = makeAddr("WETH");
    address internal user      = makeAddr("user");        // the pinned recipient
    address internal attacker  = makeAddr("attacker");
    address internal delegator = makeAddr("delegator");

    uint128 internal constant MAX_IN   = 20_000_000;   // 20 USDC (6dp)
    uint128 internal constant MIN_OUT  = 5_000_000_000_000_000; // 0.005 WETH (18dp)

    ModeCode internal constant SINGLE_DEFAULT = ModeCode.wrap(bytes32(0));
    bytes32  internal constant DHASH = keccak256("swap-delegation");

    function setUp() public {
        enforcer = new SwapBoundsEnforcer();
    }

    // ---- builders ----------------------------------------------------------

    function _terms() internal view returns (bytes memory) {
        return abi.encodePacked(router, tokenIn, tokenOut, MAX_IN, MIN_OUT, user);
    }

    function _goodParams() internal view returns (ISwapRouter02.ExactInputSingleParams memory) {
        return ISwapRouter02.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: 500,
            recipient: user,
            amountIn: MAX_IN,
            amountOutMinimum: MIN_OUT,
            sqrtPriceLimitX96: 0
        });
    }

    /// Pack a single-call execution: target(20) ++ value(32) ++ callData.
    function _exec(address target, uint256 value, bytes memory callData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(target, value, callData);
    }

    function _swapCalldata(ISwapRouter02.ExactInputSingleParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISwapRouter02.exactInputSingle, (p));
    }

    function _run(bytes memory terms, bytes memory exec) internal {
        enforcer.beforeHook(terms, "", SINGLE_DEFAULT, exec, DHASH, delegator, address(0));
    }

    // ---- happy path --------------------------------------------------------

    function test_AllowsBoundedSwap() public {
        bytes memory exec = _exec(router, 0, _swapCalldata(_goodParams()));
        // amountIn AT the cap, minOut AT the floor — both boundaries inclusive.
        _run(_terms(), exec);
    }

    function test_AllowsUnderCapAndAboveFloor() public {
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.amountIn = MAX_IN - 1;
        p.amountOutMinimum = uint256(MIN_OUT) + 1e18; // demanding MORE than the floor is fine
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_EmitsSwapBounded() public {
        vm.recordLogs();
        _run(_terms(), _exec(router, 0, _swapCalldata(_goodParams())));
        // One SwapBounded log from the enforcer.
        bytes32 sig = keccak256("SwapBounded(address,address,address,address,address,address,uint256,uint256,bytes32)");
        Vm_Log[] memory logs = _logs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(enforcer) && logs[i].topics[0] == sig) found = true;
        }
        assertTrue(found, "SwapBounded not emitted");
    }

    // ---- rogue rejections (the safety thesis) ------------------------------

    function test_RevertsWrongRouter() public {
        bytes memory exec = _exec(makeAddr("evilRouter"), 0, _swapCalldata(_goodParams()));
        vm.expectRevert(bytes("SwapBounds:wrong-router"));
        _run(_terms(), exec);
    }

    function test_RevertsNativeValue() public {
        bytes memory exec = _exec(router, 1, _swapCalldata(_goodParams()));
        vm.expectRevert(bytes("SwapBounds:no-native-value-allowed"));
        _run(_terms(), exec);
    }

    function test_RevertsWrongSelector() public {
        // Same length (228) but a different selector.
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        bytes memory wrong = abi.encodeWithSelector(bytes4(0xdeadbeef),
            p.tokenIn, p.tokenOut, p.fee, p.recipient, p.amountIn, p.amountOutMinimum, p.sqrtPriceLimitX96);
        vm.expectRevert(bytes("SwapBounds:not-swap-selector"));
        _run(_terms(), _exec(router, 0, wrong));
    }

    function test_RevertsWrongTokenIn() public {
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.tokenIn = makeAddr("rugTokenIn");
        vm.expectRevert(bytes("SwapBounds:wrong-token-in"));
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_RevertsWrongTokenOut() public {
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.tokenOut = makeAddr("rugTokenOut");
        vm.expectRevert(bytes("SwapBounds:wrong-token-out"));
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_RevertsOverCap() public {
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.amountIn = uint256(MAX_IN) + 1;
        vm.expectRevert(bytes("SwapBounds:amount-exceeds-cap"));
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_RevertsMinOutTooLow() public {
        // A hijacked agent accepting a worse fill (lower slippage floor).
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.amountOutMinimum = uint256(MIN_OUT) - 1;
        vm.expectRevert(bytes("SwapBounds:min-out-too-low"));
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_RevertsRedirectedRecipient() public {
        // The classic: hijacked agent routes the bought token to itself.
        ISwapRouter02.ExactInputSingleParams memory p = _goodParams();
        p.recipient = attacker;
        vm.expectRevert(bytes("SwapBounds:wrong-recipient"));
        _run(_terms(), _exec(router, 0, _swapCalldata(p)));
    }

    function test_RevertsBadCalldataLength() public {
        vm.expectRevert(bytes("SwapBounds:invalid-calldata-length"));
        _run(_terms(), _exec(router, 0, hex"12345678"));
    }

    function test_RevertsBadTermsLength() public {
        vm.expectRevert(bytes("SwapBounds:invalid-terms-length"));
        _run(hex"deadbeef", _exec(router, 0, _swapCalldata(_goodParams())));
    }

    // ---- minimal log access (avoids importing Vm.Log type name clashes) ----
    struct Vm_Log { bytes32[] topics; bytes data; address emitter; }
    function _logs() internal returns (Vm_Log[] memory out) {
        Vm.Log[] memory raw = vm.getRecordedLogs();
        out = new Vm_Log[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            out[i] = Vm_Log(raw[i].topics, raw[i].data, raw[i].emitter);
        }
    }
}
