// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockVault} from "./MockVault.sol";

/// @dev A vault whose withdrawal burns a set amount of gas before it pays, standing in for an
///      expensive real one (a Morpho Vault V2 withdrawal estimates about 430,000 gas): at a tight
///      enough limit it runs out of gas inside a charge.
contract HungryVault is MockVault {
    uint256 public appetite;

    constructor(IERC20 asset_, uint256 appetite_) MockVault(asset_) {
        appetite = appetite_;
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256 shares) {
        uint256 start = gasleft();
        while (start - gasleft() < appetite) {}
        return super.withdraw(assets, receiver, owner);
    }
}
