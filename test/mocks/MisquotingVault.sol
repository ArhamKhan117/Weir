// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockVault} from "./MockVault.sol";

/// @title MisquotingVault
/// @notice A `MockVault` that can stop answering the two questions the hub asks it before a
///         charge, `previewWithdraw` and the share `balanceOf`: either can revert, the way a vault
///         paused at its implementation behind a proxy or one mid-migration can, or return no data
///         at all, an answer a typed call cannot decode.
/// @dev The vault's own `withdraw` asks the same questions (it prices the shares with
///      `previewWithdraw`, and outside the zero-max mode bounds them with `balanceOf`), so a fault
///      reaches it too, as it would a real vault that is down.
contract MisquotingVault is MockVault {
    enum Fault {
        None,
        Reverts,
        AnswersNothing
    }

    Fault public previewFault;
    Fault public balanceFault;

    constructor(IERC20 asset_) MockVault(asset_) {}

    function setFaults(Fault preview, Fault balance) external {
        previewFault = preview;
        balanceFault = balance;
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        _misquote(previewFault);
        return super.previewWithdraw(assets);
    }

    function balanceOf(address account) public view override(ERC20, IERC20) returns (uint256) {
        _misquote(balanceFault);
        return super.balanceOf(account);
    }

    function _misquote(Fault fault) private pure {
        if (fault == Fault.Reverts) revert("MisquotingVault: no quote");
        if (fault == Fault.AnswersNothing) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
    }
}
