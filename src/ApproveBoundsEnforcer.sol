// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title ApproveBoundsEnforcer
 * @author Conduit
 * @notice Caveat enforcer that bounds a delegated ERC-20 `approve`. It exists so
 *         the router allowance a swap needs can ride the SAME 1Shot batch as the
 *         swap (gas paid in USDC — the user never needs ETH), without handing the
 *         agent an open-ended approval.
 *
 *         A redelegation carrying this enforcer can only ever approve ONE token,
 *         to ONE spender (the swap router), up to a capped amount. Paired with
 *         {SwapBoundsEnforcer} on the swap leg, the trade is `[approve, swap]` in a
 *         single redeemDelegations: the exact allowance is granted and consumed
 *         atomically, so no standing over-approval is ever left behind.
 *
 * @dev    Single-call, default-exec only. Mirrors X402ReceiptEnforcer's hardened
 *         shape (length-check first, then field checks).
 */
contract ApproveBoundsEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    // ---------------------------------------------------------------------
    // Layout of `_terms` (56 bytes, packed):
    //   [ 0:20]  token      (address)   the ERC-20 that may be approved
    //   [20:40]  spender    (address)   the only allowed spender (the router)
    //   [40:56]  maxAmount  (uint128)   approval cap, token base units
    // ---------------------------------------------------------------------
    uint256 private constant TERMS_LENGTH = 56;

    // approve(address,uint256): selector(4) + 32 + 32 = 68 bytes
    uint256 private constant APPROVE_CALLDATA_LENGTH = 68;

    event ApproveBounded(
        address indexed delegationManager,
        address indexed delegator,
        address indexed spender,
        address token,
        uint256 amount,
        bytes32 delegationHash
    );

    function beforeHook(
        bytes calldata _terms,
        bytes calldata, // _args -- unused
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address _delegator,
        address // _redeemer -- unconstrained at this hop
    )
        public
        override
        onlySingleCallTypeMode(_mode)
        onlyDefaultExecutionMode(_mode)
    {
        (address token, address spender, uint256 maxAmount) = getTermsInfo(_terms);

        (address target, uint256 value, bytes calldata callData) =
            _executionCallData.decodeSingle();

        require(callData.length == APPROVE_CALLDATA_LENGTH, "ApproveBounds:invalid-calldata-length");
        require(target == token, "ApproveBounds:wrong-token");
        require(value == 0, "ApproveBounds:no-native-value-allowed");
        require(bytes4(callData[0:4]) == IERC20.approve.selector, "ApproveBounds:not-approve-selector");

        (address callSpender, uint256 amount) = abi.decode(callData[4:], (address, uint256));

        require(callSpender == spender, "ApproveBounds:wrong-spender");
        require(amount <= maxAmount, "ApproveBounds:amount-exceeds-cap");

        emit ApproveBounded(msg.sender, _delegator, spender, token, amount, _delegationHash);
    }

    function getTermsInfo(bytes calldata _terms)
        public
        pure
        returns (address token, address spender, uint256 maxAmount)
    {
        require(_terms.length == TERMS_LENGTH, "ApproveBounds:invalid-terms-length");
        token     = address(bytes20(_terms[0:20]));
        spender   = address(bytes20(_terms[20:40]));
        maxAmount = uint256(uint128(bytes16(_terms[40:56])));
    }
}
