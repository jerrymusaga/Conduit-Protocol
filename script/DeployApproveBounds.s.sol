// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script, console2 } from "forge-std/Script.sol";
import { ApproveBoundsEnforcer } from "../src/ApproveBoundsEnforcer.sol";

/**
 * @notice Deploys ApproveBoundsEnforcer.
 *   source .env
 *   forge script script/DeployApproveBounds.s.sol:DeployApproveBounds \
 *     --rpc-url base_sepolia --broadcast --verify -vvv
 */
contract DeployApproveBounds is Script {
    function run() external returns (ApproveBoundsEnforcer enforcer) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPk);
        enforcer = new ApproveBoundsEnforcer();
        vm.stopBroadcast();
        console2.log("ApproveBoundsEnforcer deployed at:", address(enforcer));
        console2.log("Network chain id:", block.chainid);
    }
}
