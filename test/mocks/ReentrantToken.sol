// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ReentrantToken
/// @notice A six-decimal ERC-20 with `permit` whose `transferFrom` can be armed to make one call
///         of the test's choosing before it moves anything, the way a token with transfer hooks
///         hands control to someone else mid-transfer.
/// @dev The armed call runs once and its revert is bubbled, so a test sees exactly why it failed.
contract ReentrantToken is ERC20, ERC20Permit {
    address public hookTarget;
    bytes public hookData;

    constructor() ERC20("Reentrant Dollar", "REUSD") ERC20Permit("Reentrant Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Make the next `transferFrom` call `target` with `data` first.
    function arm(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        address target = hookTarget;
        if (target != address(0)) {
            hookTarget = address(0);
            (bool ok, bytes memory ret) = target.call(hookData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        return super.transferFrom(from, to, value);
    }
}
