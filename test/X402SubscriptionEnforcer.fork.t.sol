// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test, Vm } from "forge-std/Test.sol";
import { X402SubscriptionEnforcer } from "../src/X402SubscriptionEnforcer.sol";
import { IERC20 } from "../src/X402ReceiptEnforcer.sol";
import { MinimalAccount } from "./helpers/MinimalAccount.sol";
import { BaseSepoliaConstants } from "./helpers/Constants.sol";

/**
 * @notice Integration test against the LIVE MetaMask DelegationManager on Base
 *         Sepolia, for X402SubscriptionEnforcer. Proves the recurring-payment
 *         property end-to-end:
 *           1. A subscription-bound redelegation charges once (period 1) — USDC
 *              moves, X402SubscriptionCharged emitted.
 *           2. A SECOND redemption in the same period reverts (no double-charge).
 *
 *         Run with:
 *           forge test --fork-url $BASE_SEPOLIA_RPC_URL \
 *             --match-contract X402SubscriptionEnforcerForkTest -vvv
 */
interface IDelegationManager {
    struct Caveat { address enforcer; bytes terms; bytes args; }
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

contract X402SubscriptionEnforcerForkTest is Test {
    address internal userEoa;
    uint256 internal userPk;
    address internal userSmartAccount;
    address internal coordinator;
    uint256 internal coordinatorPk;
    address internal specialist;
    address internal merchant;

    X402SubscriptionEnforcer internal enforcer;

    bytes32 internal constant SUB_ID = keccak256("conduit-sub-fork-001");
    uint128 internal constant AMOUNT = 5_000; // fixed price per period
    uint32  internal constant PERIOD = 3600;  // 1 hour
    bytes32 internal constant ZERO_MODE = bytes32(0);

    function setUp() public {
        (userEoa, userPk)            = makeAddrAndKey("user");
        (coordinator, coordinatorPk) = makeAddrAndKey("coordinator");
        (specialist, )               = makeAddrAndKey("specialist");
        merchant                     = makeAddr("merchant");

        enforcer = new X402SubscriptionEnforcer();
        userSmartAccount = address(new MinimalAccount(userEoa, BaseSepoliaConstants.DELEGATION_MANAGER));
        deal(BaseSepoliaConstants.USDC, userSmartAccount, 1_000_000); // 1 USDC
    }

    function test_SubscriptionChargesOncePerPeriod() public {
        IDelegationManager dm = IDelegationManager(BaseSepoliaConstants.DELEGATION_MANAGER);

        // ---- root: period-transfer budget (the recurring envelope) ----
        IDelegationManager.Caveat[] memory rootCaveats = new IDelegationManager.Caveat[](1);
        rootCaveats[0] = IDelegationManager.Caveat({
            enforcer: BaseSepoliaConstants.ERC20_PERIOD_TRANSFER_ENFORCER,
            terms: abi.encodePacked(
                BaseSepoliaConstants.USDC, uint256(100_000), uint256(PERIOD), uint256(block.timestamp)
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
        root.signature = _sign(dm, root, userPk);
        bytes32 rootHash = dm.getDelegationHash(root);

        // ---- child: bound to the subscription via our enforcer ----
        IDelegationManager.Caveat[] memory childCaveats = new IDelegationManager.Caveat[](1);
        childCaveats[0] = IDelegationManager.Caveat({
            enforcer: address(enforcer),
            terms: abi.encodePacked(SUB_ID, BaseSepoliaConstants.USDC, merchant, AMOUNT, PERIOD, uint16(0)),
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
        child.signature = _sign(dm, child, coordinatorPk);

        IDelegationManager.Delegation[] memory chain = new IDelegationManager.Delegation[](2);
        chain[0] = child;
        chain[1] = root;
        bytes[] memory permissionContexts = new bytes[](1);
        permissionContexts[0] = abi.encode(chain);
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = ZERO_MODE;
        bytes[] memory execs = new bytes[](1);
        execs[0] = abi.encodePacked(
            BaseSepoliaConstants.USDC, uint256(0), IERC20.transfer.selector, abi.encode(merchant, uint256(AMOUNT))
        );

        // ---- 1) first charge (period 1) succeeds, USDC moves ----
        uint256 merchantBefore = IUSDC(BaseSepoliaConstants.USDC).balanceOf(merchant);
        vm.prank(specialist);
        dm.redeemDelegations(permissionContexts, modes, execs);
        assertEq(
            IUSDC(BaseSepoliaConstants.USDC).balanceOf(merchant) - merchantBefore,
            AMOUNT,
            "first charge should move AMOUNT"
        );

        // ---- 2) second charge in the SAME period reverts ----
        vm.prank(specialist);
        vm.expectRevert();
        dm.redeemDelegations(permissionContexts, modes, execs);

        emit log("=========================================");
        emit log("FORK PASSED: subscription charged once; double-charge blocked");
        emit log("=========================================");
    }

    function _sign(IDelegationManager dm, IDelegationManager.Delegation memory d, uint256 pk)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", BaseSepoliaConstants.DOMAIN_SEPARATOR, dm.getDelegationHash(d)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
