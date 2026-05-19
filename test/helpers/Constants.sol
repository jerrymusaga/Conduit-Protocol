// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @notice Live framework addresses + EIP-712 domain on Base Sepolia (84532).
///         Pulled from MetaMask's delegation-deployments package (v1.3.0),
///         plus `cast call DM 'eip712Domain()(...)'` for the domain values.
library BaseSepoliaConstants {
    uint256 internal constant CHAIN_ID = 84532;

    address internal constant DELEGATION_MANAGER =
        0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;

    address internal constant ID_ENFORCER =
        0xC8B5D93463c893401094cc70e66A206fb5987997;

    address internal constant ERC20_PERIOD_TRANSFER_ENFORCER =
        0x474e3Ae7E169e940607cC624Da8A15Eb120139aB;

    address internal constant USDC =
        0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @dev Pre-computed: keccak256(abi.encode(
    ///        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    ///        keccak256("DelegationManager"),
    ///        keccak256("1"),
    ///        84532,
    ///        DELEGATION_MANAGER
    ///      ))
    bytes32 internal constant DOMAIN_SEPARATOR =
        0xe71b8491d8c286677a45fed98624307811de12477341393c8399d0e58648242f;

    /// @dev MetaMask DM's sentinel for "this is a root delegation". Yes, it's
    ///      all-ones, not zero. Yes, that's surprising. Source:
    ///        cast call $DM 'ROOT_AUTHORITY()(bytes32)'
    bytes32 internal constant ROOT_AUTHORITY = bytes32(type(uint256).max);
}
