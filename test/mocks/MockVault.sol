// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MockVault
/// @notice An ERC-4626 vault with the failure modes a mandate drawn from savings has to survive:
///         a liquidity cap on withdrawals, a withdrawal that pays the receiver short, and the
///         Morpho Vault V2 shape, whose `max*` views answer zero for everyone by design.
/// @dev Yield is simulated by minting the underlying straight into the vault, which raises the
///      share price the way interest does.
contract MockVault is ERC4626 {
    /// @notice Most the vault will let anyone withdraw right now, `type(uint256).max` for no cap.
    uint256 public liquidity = type(uint256).max;

    /// @notice When set, `withdraw` burns the right shares but sends one base unit less.
    bool public paysShort;

    /// @notice When set, `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` answer zero for
    ///         everyone and no entry point consults them, as Morpho Vault V2 does by design, while
    ///         previews, deposits and withdrawals work as before. The liquidity cap then shows only
    ///         as a withdrawal that reverts `InsufficientLiquidity`, as it does there.
    bool public zeroMax;

    /// @notice A withdrawal above what the vault can pay out right now.
    error InsufficientLiquidity(uint256 assets, uint256 liquidity);

    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Mock Savings", "mSAVE") {}

    function setLiquidity(uint256 liquidity_) external {
        liquidity = liquidity_;
    }

    function setPaysShort(bool paysShort_) external {
        paysShort = paysShort_;
    }

    function setZeroMax(bool zeroMax_) external {
        zeroMax = zeroMax_;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return zeroMax ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return zeroMax ? 0 : super.maxMint(receiver);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return zeroMax ? 0 : Math.min(super.maxWithdraw(owner), liquidity);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return zeroMax ? 0 : super.maxRedeem(owner);
    }

    function deposit(uint256 assets, address receiver) public virtual override returns (uint256 shares) {
        if (!zeroMax) return super.deposit(assets, receiver);
        shares = previewDeposit(assets);
        _deposit(_msgSender(), receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) public virtual override returns (uint256 assets) {
        if (!zeroMax) return super.mint(shares, receiver);
        assets = previewMint(shares);
        _deposit(_msgSender(), receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        virtual
        override
        returns (uint256 shares)
    {
        if (!zeroMax) return super.withdraw(assets, receiver, owner);
        shares = previewWithdraw(assets);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) public virtual override returns (uint256 assets) {
        if (!zeroMax) return super.redeem(shares, receiver, owner);
        assets = previewRedeem(shares);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
    }

    /// @dev The liquidity cap holds on every way out, whatever the `max*` views say.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (assets > liquidity) revert InsufficientLiquidity(assets, liquidity);
        super._withdraw(caller, receiver, owner, paysShort ? assets - 1 : assets, shares);
    }
}
