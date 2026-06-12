// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { X402ReceiptEnforcer } from "../src/X402ReceiptEnforcer.sol";
import { X402SubscriptionEnforcer } from "../src/X402SubscriptionEnforcer.sol";
import { SwapBoundsEnforcer } from "../src/SwapBoundsEnforcer.sol";
import { ApproveBoundsEnforcer } from "../src/ApproveBoundsEnforcer.sol";
import { SwapAllowlistEnforcer } from "../src/SwapAllowlistEnforcer.sol";
import { YieldAllowlistEnforcer } from "../src/YieldAllowlistEnforcer.sol";

/**
 * @notice Full enforcer-family deploy for the mainnet cutover. Deploys every
 *         enforcer in ONE broadcast and prints the addresses to paste into the
 *         dapp config (conduit-dapp/lib/config.ts, chain 8453) or the dapp env.
 *
 *         Run with:
 *           source .env
 *           forge script script/DeployMainnet.s.sol:DeployMainnet \
 *             --rpc-url base --broadcast --verify -vvv
 *
 *         Reads DEPLOYER_PRIVATE_KEY from the environment. No constructor args —
 *         the Delegation Manager looks each enforcer up by address at call time.
 */
contract DeployMainnet is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        X402ReceiptEnforcer receipt = new X402ReceiptEnforcer();
        X402SubscriptionEnforcer subscription = new X402SubscriptionEnforcer();
        SwapBoundsEnforcer swapBounds = new SwapBoundsEnforcer();
        ApproveBoundsEnforcer approveBounds = new ApproveBoundsEnforcer();
        SwapAllowlistEnforcer swapAllowlist = new SwapAllowlistEnforcer();
        YieldAllowlistEnforcer yieldAllowlist = new YieldAllowlistEnforcer();
        vm.stopBroadcast();

        console2.log("Network chain id:", block.chainid);
        console2.log("Deployer:", vm.addr(deployerPk));
        console2.log("X402ReceiptEnforcer:", address(receipt));
        console2.log("X402SubscriptionEnforcer:", address(subscription));
        console2.log("SwapBoundsEnforcer:", address(swapBounds));
        console2.log("ApproveBoundsEnforcer:", address(approveBounds));
        console2.log("SwapAllowlistEnforcer:", address(swapAllowlist));
        console2.log("YieldAllowlistEnforcer:", address(yieldAllowlist));
    }
}
