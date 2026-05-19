// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { X402ReceiptEnforcer } from "../src/X402ReceiptEnforcer.sol";

/**
 * @notice Deploys X402ReceiptEnforcer to the configured network.
 *
 *         Run with:
 *           source .env
 *           forge script script/Deploy.s.sol:Deploy \
 *             --rpc-url base_sepolia \
 *             --broadcast \
 *             --verify \
 *             -vvv
 *
 *         Reads DEPLOYER_PRIVATE_KEY from the environment. No other config —
 *         the enforcer has no constructor args (the framework looks it up by
 *         address at call time, not by registration).
 */
contract Deploy is Script {
    function run() external returns (X402ReceiptEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        enforcer = new X402ReceiptEnforcer();
        vm.stopBroadcast();

        console2.log("X402ReceiptEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
        console2.log("Deployer:", vm.addr(deployerPk));
    }
}
