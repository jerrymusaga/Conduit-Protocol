// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test, Vm } from "forge-std/Test.sol";
import { X402ReceiptEnforcer, IERC20 } from "../src/X402ReceiptEnforcer.sol";
import { MinimalAccount } from "./helpers/MinimalAccount.sol";
import { BaseSepoliaConstants } from "./helpers/Constants.sol";

/**
 * @notice Integration test against the LIVE MetaMask DelegationManager on
 *         Base Sepolia. Validates the single architectural claim Conduit
 *         depends on:
 *
 *             When X402ReceiptEnforcer is attached to a *redelegation* of
 *             an ERC-7715-shaped root permission, the enforcer's beforeHook
 *             fires on every redemption.
 *
 *         This file is the production version of the spike-3 fork test
 *         (`spikes/3-mm-redelegation-with-custom-caveat/fork_redelegation.t.sol`).
 *         Same shape, same chain encoding, same EIP-712 domain.
 *
 *         Run with:
 *           forge test --fork-url $BASE_SEPOLIA_RPC_URL \
 *             --match-contract X402ReceiptEnforcerForkTest -vvv
 */

// Minimal DM interface. NOTE: redeemDelegations returns NO data in v1.3.0
// on Base Sepolia; declaring a return type makes Solidity revert at the
// call site trying to decode empty bytes after the call already succeeded.
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

contract X402ReceiptEnforcerForkTest is Test {
    // Actors
    address internal userEOA;
    uint256 internal userPK;
    address internal userSmartAccount;
    address internal coordinator;
    uint256 internal coordinatorPK;
    address internal specialist;
    address internal payTo;

    X402ReceiptEnforcer internal enforcer;

    bytes32 internal constant INTENT_HASH = keccak256("conduit-fork-test-001");
    uint128 internal constant MAX_AMOUNT  = 10_000;

    bytes32 internal constant ZERO_MODE = bytes32(0);

    function setUp() public {
        (userEOA, userPK)               = makeAddrAndKey("user");
        (coordinator, coordinatorPK)    = makeAddrAndKey("coordinator");
        (specialist, )                  = makeAddrAndKey("specialist");
        payTo                           = makeAddr("payTo");

        enforcer = new X402ReceiptEnforcer();

        userSmartAccount = address(new MinimalAccount(
            userEOA,
            BaseSepoliaConstants.DELEGATION_MANAGER
        ));

        // Fund the smart account with USDC via storage-write cheat.
        deal(BaseSepoliaConstants.USDC, userSmartAccount, 1_000_000); // 1 USDC
    }

    function test_RedelegationRunsCustomCaveat() public {
        IDelegationManager dm = IDelegationManager(BaseSepoliaConstants.DELEGATION_MANAGER);

        // ---------- 1. Root delegation ----------
        IDelegationManager.Caveat[] memory rootCaveats =
            new IDelegationManager.Caveat[](1);
        rootCaveats[0] = IDelegationManager.Caveat({
            enforcer: BaseSepoliaConstants.ERC20_PERIOD_TRANSFER_ENFORCER,
            terms: abi.encodePacked(
                BaseSepoliaConstants.USDC,
                uint256(100_000), // 0.1 USDC per period
                uint256(3600),    // 1 hour
                uint256(block.timestamp)
            ),
            args: ""
        });

        IDelegationManager.Delegation memory root = IDelegationManager.Delegation({
            delegate: coordinator,
            delegator: userSmartAccount,
            authority: BaseSepoliaConstants.ROOT_AUTHORITY,
            caveats: rootCaveats,
            salt: 0,
            signature: hex""
        });
        root.signature = _signDelegation(dm, root, userPK);
        bytes32 rootHash = dm.getDelegationHash(root);

        // ---------- 2. Child delegation with our enforcer ----------
        IDelegationManager.Caveat[] memory childCaveats =
            new IDelegationManager.Caveat[](2);

        // (a) Built-in IdEnforcer for one-shot replay protection
        childCaveats[0] = IDelegationManager.Caveat({
            enforcer: BaseSepoliaConstants.ID_ENFORCER,
            terms: abi.encode(uint256(INTENT_HASH)),
            args: ""
        });

        // (b) Our X402ReceiptEnforcer binding to the intent
        childCaveats[1] = IDelegationManager.Caveat({
            enforcer: address(enforcer),
            terms: abi.encodePacked(
                INTENT_HASH,
                BaseSepoliaConstants.USDC,
                payTo,
                MAX_AMOUNT,
                uint8(0)
            ),
            args: ""
        });

        IDelegationManager.Delegation memory child = IDelegationManager.Delegation({
            delegate: specialist,
            delegator: coordinator,
            authority: rootHash,
            caveats: childCaveats,
            salt: 1,
            signature: hex""
        });
        child.signature = _signDelegation(dm, child, coordinatorPK);

        // ---------- 3. Encode the redemption ----------
        // Chain MUST be [leaf, ..., root]; otherwise the DM rejects with
        // InvalidDelegate() because chain[0].delegate is checked against
        // msg.sender first.
        IDelegationManager.Delegation[] memory chain =
            new IDelegationManager.Delegation[](2);
        chain[0] = child;
        chain[1] = root;
        bytes[] memory permissionContexts = new bytes[](1);
        permissionContexts[0] = abi.encode(chain);

        bytes32[] memory modes = new bytes32[](1);
        modes[0] = ZERO_MODE;

        bytes[] memory executionCallDatas = new bytes[](1);
        executionCallDatas[0] = abi.encodePacked(
            BaseSepoliaConstants.USDC,
            uint256(0),
            IERC20.transfer.selector,
            abi.encode(payTo, uint256(MAX_AMOUNT))
        );

        // ---------- 4. Redeem ----------
        uint256 userBalanceBefore  = IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount);
        uint256 payToBalanceBefore = IUSDC(BaseSepoliaConstants.USDC).balanceOf(payTo);

        vm.recordLogs();
        vm.prank(specialist);
        dm.redeemDelegations(permissionContexts, modes, executionCallDatas);

        Vm.Log[] memory entries = vm.getRecordedLogs();

        // ---------- 5. Asserts ----------

        // (a) USDC moved
        uint256 userBalanceAfter  = IUSDC(BaseSepoliaConstants.USDC).balanceOf(userSmartAccount);
        uint256 payToBalanceAfter = IUSDC(BaseSepoliaConstants.USDC).balanceOf(payTo);
        assertEq(userBalanceBefore - userBalanceAfter, MAX_AMOUNT, "user balance");
        assertEq(payToBalanceAfter - payToBalanceBefore, MAX_AMOUNT, "payTo balance");

        // (b) X402IntentSettled emitted by our enforcer with our intent.
        //     NOTE: the `delegator` field in the event is the IMMEDIATE
        //     delegator of the delegation carrying the caveat (coordinator),
        //     NOT the root delegator (userSmartAccount). That's correct
        //     caveat-enforcer semantics. Receipts that need to record the
        //     root payer should surface it in the x402 intent payload.
        bytes32 sig = keccak256(
            "X402IntentSettled(address,address,address,bytes32,uint256,address,bytes32)"
        );
        bool foundOurEvent = false;
        for (uint256 i = 0; i < entries.length; i++) {
            Vm.Log memory e = entries[i];
            if (
                e.emitter == address(enforcer) &&
                e.topics.length == 4 &&
                e.topics[0] == sig &&
                e.topics[3] == bytes32(uint256(uint160(payTo)))
            ) {
                (bytes32 intent, uint256 amt, address tok, ) =
                    abi.decode(e.data, (bytes32, uint256, address, bytes32));
                if (
                    intent == INTENT_HASH &&
                    amt == MAX_AMOUNT &&
                    tok == BaseSepoliaConstants.USDC
                ) {
                    foundOurEvent = true;
                    break;
                }
            }
        }
        assertTrue(foundOurEvent, "X402IntentSettled with our intent was not emitted");

        emit log("=========================================");
        emit log("FORK TEST PASSED: custom caveat ran on redelegation hop");
        emit log("=========================================");
    }

    // ---- helpers --------------------------------------------------------

    function _signDelegation(
        IDelegationManager dm,
        IDelegationManager.Delegation memory d,
        uint256 pk
    ) internal view returns (bytes memory) {
        bytes32 structHash = dm.getDelegationHash(d);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            BaseSepoliaConstants.DOMAIN_SEPARATOR,
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
