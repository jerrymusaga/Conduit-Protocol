// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @notice Minimal smart account, just enough to satisfy MetaMask's
 *         DelegationManager when it acts as the root delegator in a fork
 *         test. The framework calls two functions on the root delegator:
 *
 *           - `isValidSignature(bytes32, bytes)` (EIP-1271) for signature
 *             verification. Must return `0x1626ba7e` for valid sigs.
 *
 *           - `executeFromExecutor(bytes32, bytes)` (ERC-7579 packed single)
 *             after caveats pass. Must actually perform the call.
 *
 *         A real `HybridDeleGator` does both with passkey/multisig support
 *         and modules. This stub does only ECDSA-against-owner + single-call
 *         forwarding. Plenty for tests; not for production.
 */
contract MinimalAccount {
    address public immutable OWNER;
    address public immutable DELEGATION_MANAGER;

    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;
    bytes4 private constant EIP1271_FAIL = 0xffffffff;

    constructor(address _owner, address _dm) {
        OWNER = _owner;
        DELEGATION_MANAGER = _dm;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return EIP1271_FAIL;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        address recovered = ecrecover(hash, v, r, s);
        if (recovered != address(0) && recovered == OWNER) return EIP1271_MAGIC;
        return EIP1271_FAIL;
    }

    /// @notice ERC-7579 single-call execution. Packed as (address target,
    ///         uint256 value, bytes callData).
    function executeFromExecutor(
        bytes32,
        /*mode*/
        bytes calldata executionCallData
    )
        external
        returns (bytes[] memory results)
    {
        require(msg.sender == DELEGATION_MANAGER, "MinimalAccount: only DM");
        require(executionCallData.length >= 52, "MinimalAccount: invalid exec data");

        address target;
        uint256 value;
        assembly {
            target := shr(96, calldataload(executionCallData.offset))
            value := calldataload(add(executionCallData.offset, 20))
        }
        bytes calldata callData = executionCallData[52:];

        (bool ok, bytes memory ret) = target.call{ value: value }(callData);
        require(ok, "MinimalAccount: exec failed");

        results = new bytes[](1);
        results[0] = ret;
    }

    receive() external payable { }
}
