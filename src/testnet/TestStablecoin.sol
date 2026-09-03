// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title TestStablecoin
/// @notice A six-decimal dollar token with EIP-2612 `permit` and an open faucet, for Testnet only.
/// @dev Stands in for a stablecoin that has no Testnet deployment, so the whole flow, signed
///      permit included, runs the same way it does against the real token on Mainnet. Anyone may
///      mint up to `MAX_MINT` per call, which is what lets a Testnet visitor fund a fresh account
///      from a button. Never deploy this to Mainnet; the deploy script refuses to.
contract TestStablecoin is ERC20, ERC20Permit {
    /// @notice Largest amount one `mint` call may create: 10,000 whole tokens.
    uint256 public constant MAX_MINT = 10_000e6;

    /// @notice `amount` exceeds `MAX_MINT`.
    error MintTooLarge(uint256 amount, uint256 max);

    /// @param name_ Token name, also the EIP-712 domain name `permit` signs under.
    /// @param symbol_ Token symbol.
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) {}

    /// @notice Six, like the stablecoins this stands in for.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens to `to`. Open to anyone, capped per call.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
