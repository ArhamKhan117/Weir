// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/*//////////////////////////////////////////////////////////////
                    SETTLEMENT-FAILURE REASON CODES
//////////////////////////////////////////////////////////////*/

// The same numbering as the hub's `ChargeFailed.reason`, so an indexer reads both alike.

// `SettleFailed.reason` - the payer's balance of the asset is below the amount to settle.
uint8 constant METER_REASON_INSUFFICIENT_BALANCE = 1;

// `SettleFailed.reason` - the payer's allowance to the meter is below the amount to settle.
uint8 constant METER_REASON_INSUFFICIENT_ALLOWANCE = 2;

/// @title IMandateMeter
/// @notice Metered mandates: pay-per-use under a payer's standing, capped authorization.
/// @dev A payer authorizes a merchant once (asset, a cap per period, a lifetime cap, an expiry).
///      After that the payer, or the manager key they named, signs a usage receipt per request:
///      the running total owed so far. Receipts cost nothing to sign and never touch the chain.
///      Anyone can settle the latest receipt; the meter pays the merchant the difference between
///      it and what has already been paid, never more than the caps allow, straight from the
///      payer to the merchant. Lower or older receipts change nothing, so no receipt can be used
///      twice.
interface IMandateMeter {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum Status {
        Active,
        // The last settlement could not be funded. The next one that is funded clears it.
        Delinquent,
        Cancelled
    }

    /// @notice What a payer signs once.
    /// @param merchant Who is paid.
    /// @param asset The token, one of the meter's accepted assets.
    /// @param manager A key that may sign receipts and cancel, and nothing else; zero for none.
    /// @param periodCap The most that may be settled in one period.
    /// @param period The period length, in seconds.
    /// @param maxTotal The most that may ever be settled.
    /// @param expiresAt Receipts issued after this time are not honored.
    /// @param ref An opaque reference, such as the plan it came from.
    struct Terms {
        address merchant;
        address asset;
        address manager;
        uint96 periodCap;
        uint32 period;
        uint96 maxTotal;
        uint64 expiresAt;
        bytes32 ref;
    }

    /// @notice A signed running total: everything owed to this meter so far, as of `issuedAt`.
    struct Receipt {
        uint256 meterId;
        uint96 total;
        uint64 issuedAt;
    }

    struct Meter {
        address payer;
        uint64 expiresAt;
        uint32 period;
        Status status;
        address merchant;
        uint64 periodStart;
        address asset;
        uint96 periodCap;
        address manager;
        uint96 maxTotal;
        uint96 totalCharged;
        uint96 periodCharged;
        // When it was cancelled; zero while open. Receipts issued up to then still settle.
        uint64 closedAt;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event MeterCreated(
        uint256 indexed meterId,
        address indexed payer,
        address indexed merchant,
        address asset,
        address manager,
        uint96 periodCap,
        uint32 period,
        uint96 maxTotal,
        uint64 expiresAt,
        bytes32 ref
    );

    /// @param receiptTotal The running total of the receipt settled, which may be above
    ///        `totalCharged` when a cap held part of it back for a later period.
    event UsageSettled(
        uint256 indexed meterId, address indexed merchant, uint256 amount, uint96 totalCharged, uint96 receiptTotal
    );

    event SettleFailed(uint256 indexed meterId, uint8 reason, uint256 required);

    event MeterCancelled(uint256 indexed meterId, address indexed by);

    event NonceInvalidated(address indexed signer, uint256 nonce);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidMerchant();
    error InvalidAsset(address asset);
    error InvalidPeriod();
    error InvalidPeriodCap();
    error InvalidTotalCap();
    error InvalidExpiry();
    error UnknownMeter();
    error MeterIsCancelled();
    error NotAuthorized();
    error SignatureExpired(uint256 deadline, uint256 blockTimestamp);
    error InvalidSignature();
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error ReceiptFromTheFuture(uint64 issuedAt, uint256 blockTimestamp);
    error ReceiptTooLate(uint64 issuedAt, uint64 lastHonored);
    error NothingToSettle();

    /*//////////////////////////////////////////////////////////////
                                 FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice The id the next meter will get. Ids start at 1.
    function nextMeterId() external view returns (uint256);

    /// @notice Opens a meter with `msg.sender` as the payer.
    function createMeter(Terms calldata terms) external returns (uint256 meterId);

    /// @notice Opens a meter the payer signed (EIP-712 `MeterAuthorization`), submitted by anyone.
    function createMeterWithSig(
        address payer,
        Terms calldata terms,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 meterId);

    /// @notice Pays the merchant what `receipt` says is owed beyond what is already paid, within
    ///         the caps. Callable by anyone: the payer's or manager's signature is the authority.
    /// @return amount What moved; zero when the payer could not fund it (`SettleFailed`).
    function settle(Receipt calldata receipt, bytes calldata signature) external returns (uint256 amount);

    /// @notice Ends a meter. The payer, the manager or the merchant may.
    function cancel(uint256 meterId) external;

    /// @notice Ends a meter on the payer's or manager's signature (EIP-712 `MeterCancel`).
    function cancelWithSig(uint256 meterId, address signer, uint256 nonce, uint256 deadline, bytes calldata signature)
        external;

    /// @notice Burns one of the caller's nonces.
    function invalidateNonce(uint256 nonce) external;

    function getMeter(uint256 meterId) external view returns (Meter memory);

    /// @notice What settling a receipt for `total` would pay right now, before the payer's funds
    ///         are checked: zero when nothing is owed or a cap is reached.
    function settleable(uint256 meterId, uint96 total) external view returns (uint256 amount);

    function isAcceptedAsset(address asset) external view returns (bool);

    function acceptedAssets() external view returns (address[] memory);

    function nonceUsed(address signer, uint256 nonce) external view returns (bool);

    function hashCreate(address payer, Terms calldata terms, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32);

    function hashReceipt(Receipt calldata receipt) external view returns (bytes32);

    function hashCancel(uint256 meterId, uint256 nonce, uint256 deadline) external view returns (bytes32);
}
