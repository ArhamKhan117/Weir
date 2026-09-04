// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockVault} from "./MockVault.sol";

/// @title ShortPullVault
/// @notice A `MockVault` whose `deposit` takes one base unit less than it is given while minting
///         the full shares: the vault that would leave a balance and an allowance behind in
///         whoever deposited through an approval.
contract ShortPullVault is MockVault {
    constructor(IERC20 asset_) MockVault(asset_) {}

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets - 1, shares);
    }
}
