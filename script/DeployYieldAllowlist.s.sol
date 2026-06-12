// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldAllowlistEnforcer } from "../src/YieldAllowlistEnforcer.sol";

/**
 * @notice Deploys YieldAllowlistEnforcer.
 *   source .env
 *   forge script script/DeployYieldAllowlist.s.sol:DeployYieldAllowlist \
 *     --rpc-url base_sepolia --broadcast --verify -vvv
 */
contract DeployYieldAllowlist is Script {
    function run() external returns (YieldAllowlistEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPk);
        enforcer = new YieldAllowlistEnforcer();
        vm.stopBroadcast();
        console2.log("YieldAllowlistEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
    }
}
