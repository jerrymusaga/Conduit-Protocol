// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test, Vm } from "forge-std/Test.sol";
import { SwapBoundsEnforcer, ISwapRouter02 } from "../src/SwapBoundsEnforcer.sol";
import { ApproveBoundsEnforcer } from "../src/ApproveBoundsEnforcer.sol";
import { MinimalAccount } from "./helpers/MinimalAccount.sol";

/**
 * @notice Integration test against REAL Uniswap v3 on a Base MAINNET fork. Proves
 *         the end-to-end claim trading rests on:
 *
 *           When SwapBoundsEnforcer sits on a *redelegation* (coordinator →
 *           trading agent), redeeming it executes a genuine Uniswap
 *           `exactInputSingle` swap — USDC → WETH — that lands the bought token
 *           in the USER's account, and the enforcer's beforeHook ran on the way.
 *
 *         No mock router: this is the same SwapRouter02 the dapp points at on
 *         mainnet. A redirected-recipient redemption is also shown to revert.
 *
 *         Run with:
 *           forge test --fork-url $BASE_RPC_URL \
 *             --match-contract SwapBoundsEnforcerForkTest -vvv
 */

interface IDelegationManager {
    struct Caveat {
        address enforcer;
        bytes terms;
        bytes args;
    }

    struct Delegation {
        address delegate;
        address delegator;
        bytes32 authority;
        Caveat[] caveats;
        uint256 salt;
        bytes signature;
    }
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external;
    function getDelegationHash(Delegation calldata) external pure returns (bytes32);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

contract SwapBoundsEnforcerForkTest is Test {
    // Base mainnet (8453).
    address internal constant DELEGATION_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;
    address internal constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    bytes32 internal constant ROOT_AUTHORITY = bytes32(type(uint256).max);
    bytes32 internal constant ZERO_MODE = bytes32(0);

    uint128 internal constant AMOUNT_IN = 20_000_000; // 20 USDC
    uint24 internal constant POOL_FEE = 500; // 0.05% USDC/WETH pool

    address internal userEoa;
    uint256 internal userPk;
    address internal userAccount;
    address internal coordinator;
    uint256 internal coordinatorPk;
    address internal trader;
    address internal attacker;

    SwapBoundsEnforcer internal enforcer;
    ApproveBoundsEnforcer internal approveEnforcer;
    bytes32 internal domainSeparator;

    function setUp() public {
        // Skip cleanly when no Base mainnet fork is configured.
        if (block.chainid != 8453) return;

        (userEoa, userPk) = makeAddrAndKey("user");
        (coordinator, coordinatorPk) = makeAddrAndKey("coordinator");
        (trader,) = makeAddrAndKey("trader");
        attacker = makeAddr("attacker");

        enforcer = new SwapBoundsEnforcer();
        approveEnforcer = new ApproveBoundsEnforcer();
        userAccount = address(new MinimalAccount(userEoa, DELEGATION_MANAGER));

        domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DelegationManager")),
                keccak256(bytes("1")),
                block.chainid,
                DELEGATION_MANAGER
            )
        );

        deal(USDC, userAccount, 1_000_000_000); // 1,000 USDC
        // The account approves Uniswap for USDC (Uniswap pulls via transferFrom).
        // In production this is itself a bounded redeemed execution; here we set
        // it directly to isolate the swap-redemption under test.
        vm.prank(userAccount);
        IERC20(USDC).approve(UNISWAP_ROUTER, type(uint256).max);
    }

    function _swapTerms(address recipient) internal pure returns (bytes memory) {
        // router · tokenIn · tokenOut · maxIn · minOut(floor) · recipient
        return abi.encodePacked(UNISWAP_ROUTER, USDC, WETH, AMOUNT_IN, uint128(1), recipient);
    }

    function _swapExec(address recipient, uint256 minOut) internal pure returns (bytes memory) {
        ISwapRouter02.ExactInputSingleParams memory p = ISwapRouter02.ExactInputSingleParams({
            tokenIn: USDC,
            tokenOut: WETH,
            fee: POOL_FEE,
            recipient: recipient,
            amountIn: AMOUNT_IN,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
        bytes memory callData = abi.encodeCall(ISwapRouter02.exactInputSingle, (p));
        return abi.encodePacked(UNISWAP_ROUTER, uint256(0), callData);
    }

    /// root (user → coordinator, open) + child (coordinator → trader, SwapBounds).
    function _chain(address recipient) internal view returns (bytes memory permissionContext) {
        IDelegationManager dm = IDelegationManager(DELEGATION_MANAGER);

        IDelegationManager.Caveat[] memory none = new IDelegationManager.Caveat[](0);
        IDelegationManager.Delegation memory root = IDelegationManager.Delegation({
            delegate: coordinator,
            delegator: userAccount,
            authority: ROOT_AUTHORITY,
            caveats: none,
            salt: 0,
            signature: hex""
        });
        root.signature = _sign(dm, root, userPk);
        bytes32 rootHash = dm.getDelegationHash(root);

        IDelegationManager.Caveat[] memory childCaveats = new IDelegationManager.Caveat[](1);
        childCaveats[0] =
            IDelegationManager.Caveat({ enforcer: address(enforcer), terms: _swapTerms(recipient), args: "" });
        IDelegationManager.Delegation memory child = IDelegationManager.Delegation({
            delegate: trader,
            delegator: coordinator,
            authority: rootHash,
            caveats: childCaveats,
            salt: 1,
            signature: hex""
        });
        child.signature = _sign(dm, child, coordinatorPk);

        IDelegationManager.Delegation[] memory chain = new IDelegationManager.Delegation[](2);
        chain[0] = child;
        chain[1] = root;
        permissionContext = abi.encode(chain);
    }

    /// root (user → coordinator, ApproveBounds) + child (coordinator → trader).
    function _approveChain() internal view returns (bytes memory permissionContext) {
        IDelegationManager dm = IDelegationManager(DELEGATION_MANAGER);

        IDelegationManager.Caveat[] memory rootCaveats = new IDelegationManager.Caveat[](1);
        rootCaveats[0] = IDelegationManager.Caveat({
            enforcer: address(approveEnforcer),
            terms: abi.encodePacked(USDC, UNISWAP_ROUTER, AMOUNT_IN), // token · spender · cap
            args: ""
        });
        IDelegationManager.Delegation memory root = IDelegationManager.Delegation({
            delegate: coordinator,
            delegator: userAccount,
            authority: ROOT_AUTHORITY,
            caveats: rootCaveats,
            salt: 2,
            signature: hex""
        });
        root.signature = _sign(dm, root, userPk);

        IDelegationManager.Caveat[] memory none = new IDelegationManager.Caveat[](0);
        IDelegationManager.Delegation memory child = IDelegationManager.Delegation({
            delegate: trader,
            delegator: coordinator,
            authority: dm.getDelegationHash(root),
            caveats: none,
            salt: 3,
            signature: hex""
        });
        child.signature = _sign(dm, child, coordinatorPk);

        IDelegationManager.Delegation[] memory chain = new IDelegationManager.Delegation[](2);
        chain[0] = child;
        chain[1] = root;
        permissionContext = abi.encode(chain);
    }

    /// The real flow the dapp does: [approve, swap] in ONE redeemDelegations, with
    /// NO pre-existing allowance — proving the router approval rides the same batch
    /// (gas-in-USDC via 1Shot; the user never needs ETH).
    function test_ApproveAndSwapBatch_NoPreApproval() public {
        if (block.chainid != 8453) return;

        // Start from zero allowance — the batch must grant it itself.
        vm.prank(userAccount);
        IERC20(USDC).approve(UNISWAP_ROUTER, 0);
        assertEq(IERC20(USDC).allowance(userAccount, UNISWAP_ROUTER), 0, "precondition: no allowance");

        bytes[] memory ctx = new bytes[](2);
        ctx[0] = _approveChain();
        ctx[1] = _chain(userAccount);
        bytes32[] memory modes = new bytes32[](2);
        modes[0] = ZERO_MODE;
        modes[1] = ZERO_MODE;
        bytes[] memory execs = new bytes[](2);
        execs[0] = abi.encodePacked(
            USDC, uint256(0), abi.encodeWithSignature("approve(address,uint256)", UNISWAP_ROUTER, uint256(AMOUNT_IN))
        );
        execs[1] = _swapExec(userAccount, 1);

        uint256 usdcBefore = IERC20(USDC).balanceOf(userAccount);
        uint256 wethBefore = IERC20(WETH).balanceOf(userAccount);

        vm.prank(trader);
        IDelegationManager(DELEGATION_MANAGER).redeemDelegations(ctx, modes, execs);

        assertEq(usdcBefore - IERC20(USDC).balanceOf(userAccount), AMOUNT_IN, "USDC in");
        assertGt(IERC20(WETH).balanceOf(userAccount), wethBefore, "WETH out to user");
        // Exact approval was consumed by the swap — no standing over-approval left.
        assertEq(IERC20(USDC).allowance(userAccount, UNISWAP_ROUTER), 0, "allowance fully consumed");

        emit log("=========================================");
        emit log("FORK TEST PASSED: gasless [approve, swap] batch via 1Shot-shaped redeem");
        emit log("=========================================");
    }

    function test_RealUniswapSwapThroughRedelegation() public {
        if (block.chainid != 8453) return; // only on a Base mainnet fork

        bytes[] memory ctx = new bytes[](1);
        ctx[0] = _chain(userAccount);
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = ZERO_MODE;
        bytes[] memory execs = new bytes[](1);
        execs[0] = _swapExec(userAccount, 1);

        uint256 usdcBefore = IERC20(USDC).balanceOf(userAccount);
        uint256 wethBefore = IERC20(WETH).balanceOf(userAccount);

        vm.recordLogs();
        vm.prank(trader);
        IDelegationManager(DELEGATION_MANAGER).redeemDelegations(ctx, modes, execs);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // USDC spent (exactly the cap), WETH received into the USER's account.
        assertEq(usdcBefore - IERC20(USDC).balanceOf(userAccount), AMOUNT_IN, "USDC in");
        assertGt(IERC20(WETH).balanceOf(userAccount), wethBefore, "WETH out to user");

        // The enforcer's SwapBounded receipt fired.
        bytes32 sig = keccak256("SwapBounded(address,address,address,address,address,address,uint256,uint256,bytes32)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(enforcer) && logs[i].topics[0] == sig) found = true;
        }
        assertTrue(found, "SwapBounded not emitted");

        emit log("=========================================");
        emit log("FORK TEST PASSED: real Uniswap swap via SwapBounds redelegation");
        emit log("=========================================");
    }

    function test_RedirectedProceedsRevertOnRealSwap() public {
        if (block.chainid != 8453) return;

        // Terms pin the recipient to the user; the rogue swap routes WETH to the
        // attacker → the enforcer reverts before any Uniswap call happens.
        bytes[] memory ctx = new bytes[](1);
        ctx[0] = _chain(userAccount); // bounds say recipient = userAccount
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = ZERO_MODE;
        bytes[] memory execs = new bytes[](1);
        execs[0] = _swapExec(attacker, 1); // but the call pays the attacker

        vm.prank(trader);
        vm.expectRevert(); // DM bubbles "SwapBounds:wrong-recipient"
        IDelegationManager(DELEGATION_MANAGER).redeemDelegations(ctx, modes, execs);
    }

    function _sign(IDelegationManager dm, IDelegationManager.Delegation memory d, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = dm.getDelegationHash(d);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
