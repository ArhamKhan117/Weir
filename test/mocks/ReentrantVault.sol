// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockVault} from "./MockVault.sol";

/// @title ReentrantVault
/// @notice A `MockVault` whose `deposit` and `withdraw` can be armed to make one call of the
///         test's choosing before doing anything, the way a vault that hands control to someone
///         else mid-operation would.
/// @dev The armed call runs once and its revert is bubbled, so a test sees exactly why it failed.
contract ReentrantVault is MockVault {
    address public hookTarget;
    bytes public hookData;

    constructor(IERC20 asset_) MockVault(asset_) {}

    /// @notice Make the next `deposit` or `withdraw` call `target` with `data` first.
    function arm(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        _hook();
        return super.deposit(assets, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        _hook();
        return super.withdraw(assets, receiver, owner);
    }

    function _hook() internal {
        address target = hookTarget;
        if (target == address(0)) return;
        hookTarget = address(0);
        (bool ok, bytes memory ret) = target.call(hookData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
