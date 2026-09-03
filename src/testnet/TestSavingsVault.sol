// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestStablecoin} from "./TestStablecoin.sol";

/// @title TestSavingsVault
/// @notice An ERC-4626 savings vault over a `TestStablecoin` that earns a fixed simulated rate,
///         for Testnet only, so "earn until charged" can be shown where no real yield exists.
/// @dev Interest is minted from the test token's open faucet as time passes, which raises the
///      share price exactly the way a lending vault's interest does, so a mandate drawn from here
///      behaves as one drawn from a real vault on Mainnet. Shares support EIP-2612 `permit`, so a
///      saver can authorize the hub without gas. Never deploy this to Mainnet; the deploy script
///      refuses to.
contract TestSavingsVault is ERC4626, ERC20Permit {
    /// @notice Simulated yearly rate, in basis points.
    uint256 public constant RATE_BPS = 500;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @notice When interest was last minted in.
    uint256 public lastAccrual;

    /// @param asset_ The test stablecoin this vault saves.
    /// @param name_ Share token name, also its EIP-712 permit domain name.
    /// @param symbol_ Share token symbol.
    constructor(TestStablecoin asset_, string memory name_, string memory symbol_)
        ERC4626(IERC20(address(asset_)))
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        lastAccrual = block.timestamp;
    }

    /// @notice Held assets plus interest earned since the last accrual.
    function totalAssets() public view override returns (uint256) {
        return super.totalAssets() + _pendingInterest();
    }

    function decimals() public view override(ERC20, ERC4626) returns (uint8) {
        return ERC4626.decimals();
    }

    /// @notice Mint in the interest earned so far. Anyone may call it; deposits and withdrawals do.
    function accrue() public {
        uint256 interest = _pendingInterest();
        lastAccrual = block.timestamp;

        TestStablecoin token = TestStablecoin(asset());
        uint256 maxMint = token.MAX_MINT();
        while (interest > 0) {
            uint256 chunk = Math.min(interest, maxMint);
            // Bounded by the interest owed over the faucet's per-call cap.
            // forge-lint: disable-next-line(calls-loop)
            token.mint(address(this), chunk);
            interest -= chunk;
        }
    }

    function _pendingInterest() internal view returns (uint256) {
        uint256 held = IERC20(asset()).balanceOf(address(this));
        return held * RATE_BPS * (block.timestamp - lastAccrual) / (BPS * YEAR);
    }

    /// @dev Shares were priced against `totalAssets`, which already counts pending interest, so
    ///      minting it in first keeps the price unchanged and the vault always able to pay.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        accrue();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        accrue();
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
