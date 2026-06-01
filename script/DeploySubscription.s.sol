// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { X402SubscriptionEnforcer } from "../src/X402SubscriptionEnforcer.sol";

/**
 * @notice Deploys X402SubscriptionEnforcer to the configured network.
 *
 *         Run with:
 *           source .env
 *           forge script script/DeploySubscription.s.sol:DeploySubscription \
 *             --rpc-url base_sepolia \
 *             --broadcast \
 *             --verify \
 *             -vvv
 *
 *         Reads DEPLOYER_PRIVATE_KEY from the environment. No constructor args —
 *         the framework resolves the enforcer by address at call time.
 */
contract DeploySubscription is Script {
    function run() external returns (X402SubscriptionEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        enforcer = new X402SubscriptionEnforcer();
        vm.stopBroadcast();

        console2.log("X402SubscriptionEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
        console2.log("Deployer:", vm.addr(deployerPk));
    }
}
