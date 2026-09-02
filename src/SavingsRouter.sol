// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LowLevelCall} from "@openzeppelin/contracts/utils/LowLevelCall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ISavingsRouter} from "./interfaces/ISavingsRouter.sol";

/// @title SavingsRouter
/// @notice Puts a payer's dollars into a savings vault, and takes them back out, on the payer's
///         signature alone, so a payer who holds no gas token can let money earn until a mandate
///         drawn from the vault charges it.
/// @dev Deliberately minimal in authority: no owner, no admin, no pause, no upgrade. The map from
///      asset to vault is fixed in the constructor, one vault per asset, each checked to be an
///      ERC-4626 vault over its asset, and nothing can add, change or remove a route afterwards.
///      Choosing the vaults is the one act of trust, made once at deployment.
///
///      Non-custodial by construction. The router holds nothing between calls: a deposit pulls
///      the owner's asset in, approves the vault for exactly that amount and deposits it in the
///      same call, then checks that its balance is back where it started and its allowance to the
///      vault is zero. A withdrawal never passes through the router at all: the vault burns the
///      owner's shares and pays the owner directly, with the router only as the spender of the
///      owner's share allowance. Anything sent to the router directly stays there, unreachable.
///
///      A permit to the router, like any allowance to it, is an authorization anyone may carry
///      out, but the only thing it can ever be used for is moving that much into, or out of, the
///      owner's own position in the fixed vault. Shares always go to the owner and assets always
///      go to the owner, so a submitter can decide whether and when, never where.
contract SavingsRouter is ISavingsRouter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Written once in the constructor. There is no setter.
    mapping(address asset => address vault) private _vaultOf;
    address[] private _assets;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param assets The assets the router serves, fixed for the life of the contract. Each must
    ///        be a plain ERC-20 with EIP-2612 `permit` that moves exactly the amount asked, which
    ///        the dollar stablecoins this is built for do.
    /// @param vaults The one ERC-4626 vault for each asset, in the same order: `vaults[i].asset()`
    ///        must be `assets[i]`.
    constructor(address[] memory assets, address[] memory vaults) {
        if (assets.length != vaults.length) revert LengthMismatch(assets.length, vaults.length);
        if (assets.length == 0) revert InvalidAsset(address(0));

        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            address vault = vaults[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (asset.code.length == 0 || _vaultOf[asset] != address(0)) revert InvalidAsset(asset);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!_isVaultOver(vault, asset)) revert InvalidVault(asset, vault);
            // forge-lint: disable-next-line(costly-loop)
            _vaultOf[asset] = vault;
            _assets.push(asset);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 DEPOSITS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISavingsRouter
    function depositFor(address owner, address asset, uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        override
        nonReentrant
        returns (uint256 shares)
    {
        address vault = _route(asset, assets);
        _checkDeadline(deadline);
        _permit(asset, owner, assets, deadline, v, r, s);
        return _deposit(owner, asset, vault, assets);
    }

    /// @inheritdoc ISavingsRouter
    function deposit(address asset, uint256 assets) external override nonReentrant returns (uint256 shares) {
        address vault = _route(asset, assets);
        return _deposit(msg.sender, asset, vault, assets);
    }

    /*//////////////////////////////////////////////////////////////
                               WITHDRAWALS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISavingsRouter
    function withdrawFor(
        address owner,
        address asset,
        uint256 assets,
        uint256 maxShares,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override nonReentrant returns (uint256 shares) {
        address vault = _route(asset, assets);
        _checkDeadline(deadline);
        _permit(vault, owner, maxShares, deadline, v, r, s);
        return _withdraw(owner, asset, vault, assets, maxShares);
    }

    /// @inheritdoc ISavingsRouter
    function withdraw(address asset, uint256 assets) external override nonReentrant returns (uint256 shares) {
        address vault = _route(asset, assets);
        return _withdraw(msg.sender, asset, vault, assets, type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ISavingsRouter
    function vaultFor(address asset) external view override returns (address) {
        return _vaultOf[asset];
    }

    /// @inheritdoc ISavingsRouter
    function routes() external view override returns (Route[] memory list) {
        list = new Route[](_assets.length);
        for (uint256 i = 0; i < list.length; ++i) {
            address asset = _assets[i];
            list[i] = Route({asset: asset, vault: _vaultOf[asset]});
        }
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Takes `assets` of the owner's `asset` through the router into `vault`, for the owner.
    ///
    ///      Moving funds from someone other than the caller is the point: the owner's allowance to
    ///      the router is the authority, and the only place those funds can go is the owner's own
    ///      position. The router's balance before the pull is the baseline rather than zero, so a
    ///      stray transfer to the router can never block every deposit after it.
    function _deposit(address owner, address asset, address vault, uint256 assets) private returns (uint256 shares) {
        IERC20 token = IERC20(asset);
        uint256 held = token.balanceOf(address(this));
        uint256 sharesBefore = IERC20(vault).balanceOf(owner);

        // forge-lint: disable-next-line(arbitrary-send-erc20)
        token.safeTransferFrom(owner, address(this), assets);
        token.forceApprove(vault, assets);
        // The shares are measured from the owner's balance next, not taken on the vault's word.
        // forge-lint: disable-next-line(unused-return)
        IERC4626(vault).deposit(assets, owner);

        uint256 heldAfter = token.balanceOf(address(this));
        uint256 allowanceAfter = token.allowance(address(this), vault);
        if (heldAfter != held || allowanceAfter != 0) {
            revert Residue(heldAfter > held ? heldAfter - held : 0, allowanceAfter);
        }

        shares = IERC20(vault).balanceOf(owner) - sharesBefore;
        if (shares == 0) revert NothingMinted();

        // After the calls by necessity: the shares are known only once the vault has minted them.
        // The router keeps no state for a reentrant call to see, and the lock is held throughout.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Deposited(owner, asset, vault, assets, shares);
    }

    /// @dev Has `vault` burn the owner's shares and pay exactly `assets` to the owner, with the
    ///      router as the spender of the owner's share allowance. The router never holds the
    ///      asset on this path, and both the burn and the payment are measured from the owner's
    ///      balances rather than taken on the vault's word.
    function _withdraw(address owner, address asset, address vault, uint256 assets, uint256 maxShares)
        private
        returns (uint256 shares)
    {
        IERC20 token = IERC20(asset);
        uint256 sharesBefore = IERC20(vault).balanceOf(owner);
        uint256 walletBefore = token.balanceOf(owner);

        // forge-lint: disable-next-line(unused-return)
        IERC4626(vault).withdraw(assets, owner, owner);

        shares = sharesBefore - IERC20(vault).balanceOf(owner);
        if (shares > maxShares) revert MaxSharesExceeded(shares, maxShares);
        uint256 received = token.balanceOf(owner) - walletBefore;
        if (received != assets) revert PaymentMismatch(assets, received);

        // As in `_deposit`: after the calls by necessity, with no state and the lock held.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Withdrawn(owner, asset, vault, assets, shares);
    }

    /// @dev Submits the owner's EIP-2612 permit on `token` for `value` to the router, tolerating
    ///      one that has already been used. Permits can be submitted by anyone, so a copy seen in
    ///      flight can be sent first; that sets the very allowance this call needs, and refusing to
    ///      go ahead would let anyone block every relayed deposit. When the permit fails and the
    ///      allowance falls short of `value`, the signature did not authorize this call, and the
    ///      token's own error is raised.
    function _permit(address token, address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        private
    {
        try IERC20Permit(token).permit(owner, address(this), value, deadline, v, r, s) {}
        catch (bytes memory reason) {
            if (IERC20(token).allowance(owner, address(this)) < value) LowLevelCall.bubbleRevert(reason);
        }
    }

    /// @dev The vault fixed for `asset`, refusing an asset with none and a zero amount.
    function _route(address asset, uint256 assets) private view returns (address vault) {
        vault = _vaultOf[asset];
        if (vault == address(0)) revert UnsupportedAsset(asset);
        if (assets == 0) revert InvalidAmount();
    }

    /// @dev The deadline binds the call as well as the permit, so a relayed call never lands after
    ///      the moment the owner signed for, even when the permit itself was used earlier.
    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
    }

    /// @dev True when `vault` answers `asset()` with exactly `asset`. Anything else is not a vault
    ///      over it: no code, a revert, or an answer that is not a clean address. A raw call rather
    ///      than a typed one, so a malformed answer is refused with `InvalidVault` instead of
    ///      reverting in the decoder.
    function _isVaultOver(address vault, address asset) private view returns (bool) {
        if (vault.code.length == 0) return false;

        // Called only from the constructor's loop, once per route it is given.
        // forge-lint: disable-next-line(calls-loop)
        (bool ok, bytes memory answer) = vault.staticcall(abi.encodeCall(IERC4626.asset, ()));
        if (!ok || answer.length < 32) return false;

        uint256 word = abi.decode(answer, (uint256));
        // The cast cannot truncate: the high 96 bits were just checked to be zero.
        // forge-lint: disable-next-line(unsafe-typecast)
        return word >> 160 == 0 && address(uint160(word)) == asset;
    }
}
