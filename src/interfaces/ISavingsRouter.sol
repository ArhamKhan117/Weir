// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title ISavingsRouter
/// @notice External surface of `SavingsRouter`: moves a payer's dollars into, and back out of,
///         the one ERC-4626 savings vault fixed for each asset, on the payer's EIP-2612 signature
///         and submitted by anyone. It is what lets a payer who holds no gas token keep money
///         earning until a mandate drawn from the vault charges it.
/// @dev Every value-moving path starts and ends with the owner: a deposit takes the owner's asset
///      and mints the shares to the owner, a withdrawal burns the owner's shares and pays the
///      asset to the owner. No parameter names a receiver and no parameter names a vault, so
///      whoever submits a call can choose only whether and when it happens.
interface ISavingsRouter {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice One asset and the savings vault fixed for it.
    struct Route {
        address asset;
        address vault;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice `assets` of the owner's `asset` went into `vault`, which minted `shares` to the owner.
    event Deposited(address indexed owner, address indexed asset, address vault, uint256 assets, uint256 shares);

    /// @notice `vault` burned `shares` of the owner's and paid exactly `assets` of `asset` to the owner.
    event Withdrawn(address indexed owner, address indexed asset, address vault, uint256 assets, uint256 shares);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice The constructor was given no route, or an asset that is zero, holds no code, or
    ///         appears twice.
    error InvalidAsset(address asset);
    /// @notice The constructor was given a vault that is not an ERC-4626 vault over its asset.
    error InvalidVault(address asset, address vault);
    /// @notice The constructor's asset and vault lists differ in length.
    error LengthMismatch(uint256 assets, uint256 vaults);
    /// @notice No vault is fixed for `asset`.
    error UnsupportedAsset(address asset);
    /// @notice The amount is zero.
    error InvalidAmount();
    /// @notice The signature's deadline has passed.
    error SignatureExpired(uint256 deadline, uint256 blockTimestamp);
    /// @notice The deposit would mint no shares, which would give the owner's money to the vault's
    ///         other depositors.
    error NothingMinted();
    /// @notice The withdrawal burned more of the owner's shares than the owner allowed.
    error MaxSharesExceeded(uint256 burned, uint256 maxShares);
    /// @notice The withdrawal paid the owner something other than the amount asked.
    error PaymentMismatch(uint256 expected, uint256 received);
    /// @notice The vault took something other than exactly the amount deposited, leaving `balance`
    ///         of the asset or an `allowance` to the vault behind in the router.
    error Residue(uint256 balance, uint256 allowance);

    /*//////////////////////////////////////////////////////////////
                                 MUTATORS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit `assets` of the owner's `asset` into the vault fixed for it, minting the
    ///         shares to the owner, authorized by the owner's EIP-2612 permit to this router for
    ///         exactly `assets`. Anyone may submit it.
    /// @dev A permit someone else already submitted is fine: the call goes ahead whenever the
    ///      owner's allowance to the router covers `assets`, the state that permit left. When the
    ///      permit fails and the allowance does not cover the amount, the permit's own error is
    ///      raised, so a submitter sees why.
    /// @return shares The vault shares the owner received.
    function depositFor(address owner, address asset, uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 shares);

    /// @notice Withdraw exactly `assets` of `asset` from the owner's position in the vault fixed
    ///         for it, paid to the owner, burning at most `maxShares`, authorized by the owner's
    ///         EIP-2612 permit on the vault's shares to this router for `maxShares`. Anyone may
    ///         submit it.
    /// @dev Front-running is handled as in `depositFor`, against an allowance of `maxShares`. The
    ///      vault spends only the shares it burns, so whatever of `maxShares` a withdrawal does not
    ///      burn stays allowed to the router, and can later only be withdrawn to the owner.
    /// @return shares The vault shares burned.
    function withdrawFor(
        address owner,
        address asset,
        uint256 assets,
        uint256 maxShares,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 shares);

    /// @notice `depositFor` with `msg.sender` as the owner, spending an allowance they gave the
    ///         router, for a caller who holds gas.
    function deposit(address asset, uint256 assets) external returns (uint256 shares);

    /// @notice `withdrawFor` with `msg.sender` as the owner and no share bound beyond the share
    ///         allowance they gave the router, for a caller who holds gas.
    function withdraw(address asset, uint256 assets) external returns (uint256 shares);

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The vault fixed for `asset`, or zero when there is none.
    function vaultFor(address asset) external view returns (address vault);

    /// @notice Every asset and its vault, in deployment order.
    function routes() external view returns (Route[] memory);
}
