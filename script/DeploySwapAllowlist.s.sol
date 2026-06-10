// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { SwapAllowlistEnforcer } from "../src/SwapAllowlistEnforcer.sol";

/**
 * @notice Deploys SwapAllowlistEnforcer.
 *   source .env
 *   forge script script/DeploySwapAllowlist.s.sol:DeploySwapAllowlist \
 *     --rpc-url base_sepolia --broadcast --verify -vvv
 */
contract DeploySwapAllowlist is Script {
    function run() external returns (SwapAllowlistEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPk);
        enforcer = new SwapAllowlistEnforcer();
        vm.stopBroadcast();
        console2.log("SwapAllowlistEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
    }
}
