// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title RefusingToken
/// @notice A six-decimal ERC-20 whose `transferFrom` can be switched to refuse, by returning
///         false or by reverting, while balance and allowance still read as sufficient.
/// @dev The one state the hub cannot see coming: every pre-check passes and the token still says
///      no. `charge` must revert on it, and the settlement inside `pause` and `cancel` must report
///      it and carry on.
contract RefusingToken is ERC20 {
    enum Mode {
        Normal,
        ReturnFalse,
        Revert
    }

    Mode public mode;

    constructor() ERC20("Refusing Dollar", "RUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Revert) revert("RefusingToken: refused");
        return super.transferFrom(from, to, value);
    }
}
