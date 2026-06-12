// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { X402ReceiptEnforcer, IERC20 } from "../src/X402ReceiptEnforcer.sol";
import { MinimalAccount } from "./helpers/MinimalAccount.sol";
import { BaseSepoliaConstants } from "./helpers/Constants.sol";

/**
 * @notice Integration test against the LIVE MetaMask DelegationManager +
 *         ERC20PeriodTransferEnforcer on Base Sepolia. Validates the
 *         architectural claim behind Conduit's ATOMIC MULTI-BUY:
 *
 *           N intent-bound payments (one per agent in a plan), all rooted in
 *           the SAME ERC-7715-shaped budget grant, submitted as ONE
 *           redeemDelegations batch, settle ALL-OR-NOTHING:
 *
 *             • under budget  → every seller is paid in one transaction.
 *             • over budget   → the payment that crosses the period cap
 *                               reverts, and because it's a single tx the
 *                               WHOLE batch reverts — not one cent moves.
 *
 *         The linchpin is that the ERC20PeriodTransferEnforcer keys its
 *         allowance by (delegationManager, ROOT delegationHash). Every context
 *         in the batch redelegates off the same root, so its beforeHook
 *         accumulates `transferredInCurrentPeriod` across the batch and trips
 *         `transfer-amount-exceeded` on the payment that overflows — which
 *         unwinds the entire transaction. This file proves that empirically
 *         against the deployed framework (not a mock).
 *
 *         Run with:
 *           forge test --fork-url $BASE_SEPOLIA_RPC_URL \
 *             --match-contract AtomicBatchBudgetForkTest -vvv
 */

// Minimal DM interface. NOTE: redeemDelegations returns NO data in v1.3.0 on
// Base Sepolia; declaring a return type makes Solidity revert at the call site
// trying to decode empty bytes after the call already succeeded.
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

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
}

contract AtomicBatchBudgetForkTest is Test {
    // Actors
    address internal userEoa;
    uint256 internal userPk;
    address internal userSmartAccount;
    address internal coordinator;
    uint256 internal coordinatorPk;
    address internal relayer; // the facilitator relayer = msg.sender = chain[0].delegate
    address[3] internal sellers;

    X402ReceiptEnforcer internal enforcer;

    // One agent's price. Three of these = a 3-agent procurement plan.
    uint128 internal constant PRICE = 10_000; // 0.01 USDC
    bytes32 internal constant ZERO_MODE = bytes32(0); // single call, default exec

    function setUp() public {
        (userEoa, userPk) = makeAddrAndKey("user");
        (coordinator, coordinatorPk) = makeAddrAndKey("coordinator");
        (relayer,) = makeAddrAndKey("relayer");
        sellers[0] = makeAddr("seller0");
        sellers[1] = makeAddr("seller1");
        sellers[2] = makeAddr("seller2");

        enforcer = new X402ReceiptEnforcer();

        userSmartAccount = address(new MinimalAccount(userEoa, BaseSepoliaConstants.DELEGATION_MANAGER));

        // Fund the smart account with USDC via storage-write cheat (1 USDC).
        deal(BaseSepoliaConstants.USDC, userSmartAccount, 1_000_000);
    }

    /// @notice Under budget: all three agents are paid in ONE transaction.
    function test_BatchSettlesAtomically_WhenUnderBudget() public {
        IDelegationManager dm = IDelegationManager(BaseSepoliaConstants.DELEGATION_MANAGER);

        // Budget = exactly the plan total (3 × PRICE). The third payment lands
        // right at the cap, so the whole plan should settle.
        (IDelegationManager.Delegation memory root, bytes32 rootHash) = _buildRoot(dm, uint256(PRICE) * 3);

        (bytes[] memory contexts, bytes32[] memory modes, bytes[] memory execs) = _buildBatch(dm, root, rootHash, 3);

        uint256 userBefore = IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount);

        vm.prank(relayer);
        dm.redeemDelegations(contexts, modes, execs);

        // Every seller paid, and exactly the plan total left the user.
        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                IUSDC(BaseSepoliaConstants.USDC).balanceOf(sellers[i]), PRICE, "seller should be paid in the batch"
            );
        }
        assertEq(
            userBefore - IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount),
            uint256(PRICE) * 3,
            "user should spend exactly the plan total"
        );

        emit log("=========================================");
        emit log("ATOMIC BATCH PASSED: 3 agents paid in ONE tx, within budget");
        emit log("=========================================");
    }

    /// @notice Over budget: the third payment crosses the period cap, so the
    ///         WHOLE batch reverts — the first two payments never happen. This
    ///         is the "no wasted USDC" guarantee as a hard on-chain invariant.
    function test_BatchRevertsAtomically_WhenThirdExceedsBudget() public {
        IDelegationManager dm = IDelegationManager(BaseSepoliaConstants.DELEGATION_MANAGER);

        // Budget covers only 2 of the 3 agents. The third trips
        // ERC20PeriodTransferEnforcer:transfer-amount-exceeded.
        (IDelegationManager.Delegation memory root, bytes32 rootHash) = _buildRoot(dm, uint256(PRICE) * 2);

        (bytes[] memory contexts, bytes32[] memory modes, bytes[] memory execs) = _buildBatch(dm, root, rootHash, 3);

        uint256 userBefore = IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount);

        // The overflow on payment #3 bubbles up and reverts the entire tx.
        vm.prank(relayer);
        vm.expectRevert();
        dm.redeemDelegations(contexts, modes, execs);

        // ATOMICITY: not even the first two (affordable) payments moved.
        assertEq(
            userBefore - IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount),
            0,
            "atomic revert: no USDC should leave the user"
        );
        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                IUSDC(BaseSepoliaConstants.USDC).balanceOf(sellers[i]), 0, "atomic revert: no seller should be paid"
            );
        }

        emit log("=========================================");
        emit log("ATOMIC REVERT PASSED: 3rd payment over budget unwound ALL 3 - zero spent");
        emit log("=========================================");
    }

    // ---- builders -------------------------------------------------------

    /// @dev The shared ERC-7715-shaped root: user smart account -> coordinator,
    ///      capped by the live ERC20PeriodTransferEnforcer at `periodAmount`.
    function _buildRoot(IDelegationManager dm, uint256 periodAmount)
        internal
        view
        returns (IDelegationManager.Delegation memory root, bytes32 rootHash)
    {
        IDelegationManager.Caveat[] memory rootCaveats = new IDelegationManager.Caveat[](1);
        rootCaveats[0] = IDelegationManager.Caveat({
            enforcer: BaseSepoliaConstants.ERC20_PERIOD_TRANSFER_ENFORCER,
            terms: abi.encodePacked(
                BaseSepoliaConstants.USDC,
                periodAmount,
                uint256(3600), // 1 hour period
                uint256(block.timestamp)
            ),
            args: ""
        });

        root = IDelegationManager.Delegation({
            delegate: coordinator,
            delegator: userSmartAccount,
            authority: BaseSepoliaConstants.ROOT_AUTHORITY,
            caveats: rootCaveats,
            salt: 0,
            signature: hex""
        });
        root.signature = _signDelegation(dm, root, userPk);
        rootHash = dm.getDelegationHash(root);
    }

    /// @dev One intent-bound payment leg: coordinator -> relayer, carrying
    ///      IdEnforcer (one-shot) + X402ReceiptEnforcer (binds token/seller/
    ///      amount/intent). Mirrors the production redelegation exactly.
    function _buildChild(IDelegationManager dm, bytes32 rootHash, uint256 idx, address seller, bytes32 intent)
        internal
        view
        returns (IDelegationManager.Delegation memory child)
    {
        IDelegationManager.Caveat[] memory childCaveats = new IDelegationManager.Caveat[](2);
        childCaveats[0] = IDelegationManager.Caveat({
            enforcer: BaseSepoliaConstants.ID_ENFORCER, terms: abi.encode(uint256(intent)), args: ""
        });
        childCaveats[1] = IDelegationManager.Caveat({
            enforcer: address(enforcer),
            terms: abi.encodePacked(intent, BaseSepoliaConstants.USDC, seller, PRICE, uint8(0)),
            args: ""
        });

        child = IDelegationManager.Delegation({
            delegate: relayer,
            delegator: coordinator,
            authority: rootHash,
            caveats: childCaveats,
            salt: idx + 1, // distinct per leg
            signature: hex""
        });
        child.signature = _signDelegation(dm, child, coordinatorPk);
    }

    /// @dev Assemble the batch: N permission contexts (each [child, root]), N
    ///      modes, N USDC.transfer executions — the shape redeemDelegations takes.
    function _buildBatch(IDelegationManager dm, IDelegationManager.Delegation memory root, bytes32 rootHash, uint256 n)
        internal
        view
        returns (bytes[] memory contexts, bytes32[] memory modes, bytes[] memory execs)
    {
        contexts = new bytes[](n);
        modes = new bytes32[](n);
        execs = new bytes[](n);

        for (uint256 i = 0; i < n; i++) {
            bytes32 intent = keccak256(abi.encodePacked("conduit-atomic-batch", i));
            IDelegationManager.Delegation memory child = _buildChild(dm, rootHash, i, sellers[i], intent);

            IDelegationManager.Delegation[] memory chain = new IDelegationManager.Delegation[](2);
            chain[0] = child; // chain MUST be [leaf, ..., root]
            chain[1] = root;

            contexts[i] = abi.encode(chain);
            modes[i] = ZERO_MODE;
            execs[i] = abi.encodePacked(
                BaseSepoliaConstants.USDC, uint256(0), IERC20.transfer.selector, abi.encode(sellers[i], uint256(PRICE))
            );
        }
    }

    // ---- signing --------------------------------------------------------

    function _signDelegation(IDelegationManager dm, IDelegationManager.Delegation memory d, uint256 pk)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 structHash = dm.getDelegationHash(d);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", BaseSepoliaConstants.DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
