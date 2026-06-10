// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { SwapBoundsEnforcer } from "../src/SwapBoundsEnforcer.sol";

/**
 * @notice Deploys SwapBoundsEnforcer to the configured network.
 *
 *         Run with:
 *           source .env
 *           forge script script/DeploySwapBounds.s.sol:DeploySwapBounds \
 *             --rpc-url base_sepolia \
 *             --broadcast \
 *             --verify \
 *             -vvv
 *
 *         Reads DEPLOYER_PRIVATE_KEY from the environment. No constructor args —
 *         the framework resolves the enforcer by address at call time.
 */
contract DeploySwapBounds is Script {
    function run() external returns (SwapBoundsEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        enforcer = new SwapBoundsEnforcer();
        vm.stopBroadcast();

        console2.log("SwapBoundsEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
        console2.log("Deployer:", vm.addr(deployerPk));
    }
}
