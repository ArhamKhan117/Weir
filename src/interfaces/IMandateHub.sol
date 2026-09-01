// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/*//////////////////////////////////////////////////////////////
                      CHARGE-FAILURE REASON CODES
//////////////////////////////////////////////////////////////*/

// File scope rather than inside `IMandateHub`: interfaces cannot declare variables, constant or
// not, and a file-level constant is importable by name and spelled bare at every emit site.

// For a mandate drawn from a vault, the reason is the vault's: a charge fails only when the vault
// cannot pay and the payer's balance of the asset, the fallback, cannot cover it either.

// `ChargeFailed.reason` - the payer cannot cover the charge: their balance of the asset is below
// it, or for a mandate drawn from a vault their shares are below what the vault would burn for it,
// its `previewWithdraw` of the amount.
uint8 constant REASON_INSUFFICIENT_BALANCE = 1;

// `ChargeFailed.reason` - the payer's allowance to the hub, on the asset or on the vault's shares,
// is below what the charge needs.
uint8 constant REASON_INSUFFICIENT_ALLOWANCE = 2;

// `ChargeFailed.reason` - the pull could not complete: the vault refused the withdrawal (short of
// liquidity, for one), paid the wrong amount or could not answer at all, or, in the best-effort
// settlement inside `pause` and `cancel`, the token refused the transfer. A direct mandate's
// `charge` reverts on a refused transfer instead.
uint8 constant REASON_TRANSFER_REFUSED = 3;

/*//////////////////////////////////////////////////////////////
                        SIGNED ACTION CODES
//////////////////////////////////////////////////////////////*/

// `hashAction.action` - the three lifecycle actions a payer or manager may sign.
uint8 constant ACTION_CANCEL = 1;
uint8 constant ACTION_PAUSE = 2;
uint8 constant ACTION_RESUME = 3;

/// @title IMandateHub
/// @notice External surface of `MandateHub`: standing, capped, expiring pull payments in dollar
///         stablecoins. A payer authorizes a merchant once; the money stays in the payer's own
///         account until each charge, and moves straight from payer to merchant when one executes.
/// @dev Two billing modes share one record:
///
///      - **Periodic** (`period > 0`): `amount` is charged once per `period` seconds. A charge
///        that lands several periods late advances the schedule past every missed boundary in
///        one step, so missed periods are skipped rather than owed.
///      - **Streaming** (`period == 0`): `amount` is a rate in base units per second. A charge
///        takes `amount * elapsed` since the checkpoint, clamped to the per-charge cap and to
///        what the lifetime cap has left. Accrual above the per-charge cap is forfeited rather
///        than carried, the streaming form of skipping missed periods: a payer is never hit with
///        more than `maxPerCharge` at once, however long nobody charged.
///
///      Every mandate carries three caps, all fixed at creation: `maxPerCharge`, `maxTotal` and
///      `expiresAt`. No code path widens any of them.
///
///      A mandate draws either from the payer's balance of the asset or, when it names a `vault`,
///      from the payer's shares in an ERC-4626 vault over that asset. The second is what lets
///      money keep earning until the moment it is charged: each charge withdraws exactly the
///      amount due, straight to the merchant, and nothing before.
interface IMandateHub {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Lifecycle status of a mandate.
    /// @dev Expiry is not a status: deadness is `block.timestamp > expiresAt`, so nobody pays gas
    ///      to transition a mandate at expiry and an untransitioned one can never stay chargeable.
    ///      Pausing is not a status either (see `Mandate.pausedAt`): a delinquent stream that is
    ///      paused is still delinquent. `Cancelled` is absorbing: no exit, no debits.
    enum Status {
        Active,
        Delinquent,
        Cancelled
    }

    /// @notice The terms a payer agrees to. Everything here is fixed at creation except
    ///         `manager`, which only the payer can change.
    /// @param merchant The only address a charge can pay.
    /// @param asset The token charged. Must be one of the assets fixed at deployment.
    /// @param vault Zero to draw from the payer's balance of `asset`, or an ERC-4626 vault whose
    ///        `asset()` is `asset`, to draw from the payer's shares in it. Any vault the payer
    ///        chooses: the hub checks the merchant receives exactly the amount charged, so a vault
    ///        that pays short fails the charge instead of short-paying the merchant. Funding is
    ///        judged in shares, at the vault's `previewWithdraw` of the amount; the vault's `max*`
    ///        answers are never read, so a vault that reports zero from them still works.
    /// @param manager An optional second key, typically a session key derived from the same
    ///        passkey as the payer's. It can pause, resume and cancel. It cannot create a
    ///        mandate, widen a cap, move the schedule or change the merchant. Zero means none.
    /// @param amount Base units per period, or per second when `period` is zero.
    /// @param period Seconds between charges, or zero for a streaming mandate.
    /// @param startAt First chargeable moment for a periodic mandate, or the moment accrual
    ///        begins for a streaming one. Zero means the creation block.
    /// @param maxPerCharge Ceiling on any single charge. A periodic mandate charges exactly
    ///        `amount`, so it must be at least `amount` there.
    /// @param maxTotal Lifetime ceiling across all charges.
    /// @param expiresAt Unix seconds, inclusive. No charge after it.
    /// @param ref Free for the merchant's own reconciliation, typically a plan or customer
    ///        id. Emitted in `MandateCreated` and never stored.
    struct Terms {
        address merchant;
        address asset;
        address vault;
        address manager;
        uint96 amount;
        uint32 period;
        uint64 startAt;
        uint96 maxPerCharge;
        uint96 maxTotal;
        uint64 expiresAt;
        bytes32 ref;
    }

    /// @notice A mandate as stored.
    /// @dev Six slots. `payer` doubles as the existence flag.
    ///
    ///      slot 0  [ payer 160 ][ nextChargeAt 64 ][ period 32 ]
    ///      slot 1  [ merchant 160 ][ expiresAt 64 ][ status 8 ]
    ///      slot 2  [ asset 160 ][ amount 96 ]
    ///      slot 3  [ manager 160 ][ maxPerCharge 96 ]
    ///      slot 4  [ maxTotal 96 ][ totalCharged 96 ][ pausedAt 64 ]
    ///      slot 5  [ vault 160 ]
    struct Mandate {
        address payer;
        /// @dev Periodic: the earliest moment of the next charge. Streaming: the accrual
        ///      checkpoint, the moment up to which the stream has been paid or forfeited.
        uint64 nextChargeAt;
        uint32 period;
        address merchant;
        uint64 expiresAt;
        Status status;
        address asset;
        uint96 amount;
        address manager;
        uint96 maxPerCharge;
        uint96 maxTotal;
        uint96 totalCharged;
        /// @dev Streaming only. Zero while the stream runs, the pause moment while it is paused.
        uint64 pausedAt;
        /// @dev Zero for the payer's balance of `asset`, else the ERC-4626 vault drawn from.
        address vault;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A mandate was created. Carries every agreed term, so the full authorization is
    ///         reconstructible from logs alone.
    event MandateCreated(
        uint256 indexed mandateId,
        address indexed payer,
        address indexed merchant,
        address asset,
        address vault,
        address manager,
        uint96 amount,
        uint32 period,
        uint64 nextChargeAt,
        uint96 maxPerCharge,
        uint96 maxTotal,
        uint64 expiresAt,
        bytes32 ref
    );

    /// @notice A charge succeeded.
    /// @param nextChargeAt The next boundary for a periodic mandate, or the new accrual
    ///        checkpoint for a streaming one.
    event Charged(
        uint256 indexed mandateId, address indexed merchant, uint256 amount, uint96 totalCharged, uint64 nextChargeAt
    );

    /// @notice A charge on a mandate drawn from a vault was paid from the payer's balance of the
    ///         asset instead, because the vault could not pay it. Emitted just before `Charged`.
    event ChargedFromBalance(uint256 indexed mandateId, uint256 amount);

    /// @notice A due charge could not be funded. Business state, not a protocol error: the call
    ///         returns without reverting and the schedule and totals stay exactly retryable.
    /// @param reason One of the `REASON_*` codes.
    /// @param required Base units the charge needed.
    event ChargeFailed(uint256 indexed mandateId, uint8 reason, uint256 required);

    /// @notice A mandate was cancelled by its payer, its merchant or its manager.
    event MandateCancelled(uint256 indexed mandateId, address indexed by);

    /// @notice A streaming mandate was paused. Time while paused is never billed.
    event MandatePaused(uint256 indexed mandateId, address indexed by);

    /// @notice A paused streaming mandate resumed accruing.
    event MandateResumed(uint256 indexed mandateId, address indexed by);

    /// @notice The payer replaced the mandate's manager key.
    event ManagerChanged(uint256 indexed mandateId, address indexed manager);

    /// @notice A signer burned a nonce without using it, voiding any signature that carries it.
    event NonceInvalidated(address indexed signer, uint256 nonce);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice `merchant` is the zero address, the payer, or the hub itself.
    error InvalidMerchant();
    /// @notice `asset` is not one of the assets fixed at deployment.
    error InvalidAsset(address asset);
    /// @notice `vault` is not an ERC-4626 vault over the mandate's asset.
    error InvalidVault(address vault);
    /// @notice A vault withdrawal paid the merchant something other than the amount charged.
    error PaymentMismatch(uint256 expected, uint256 received);
    /// @notice `amount` is zero.
    error InvalidAmount();
    /// @notice `period` is neither zero nor within 60 seconds to one year.
    error InvalidPeriod();
    /// @notice `maxTotal` cannot cover one charge: `amount` for a periodic mandate, one base unit
    ///         for a streaming one.
    error InvalidTotalCap();
    /// @notice `maxPerCharge` is zero, or below `amount` on a periodic mandate.
    error InvalidChargeCap();
    /// @notice `expiresAt` is not after the current block, or before the first charge.
    error InvalidExpiry();
    /// @notice No mandate exists under the given id.
    error UnknownMandate();
    /// @notice Nothing is due yet: a periodic mandate before its boundary, or a stream with
    ///         nothing accrued since its checkpoint.
    error NotDue(uint64 nextChargeAt, uint256 blockTimestamp);
    /// @notice The charge would pass the lifetime cap, or the cap is already spent.
    error TotalCapExceeded(uint96 totalCharged, uint96 maxTotal);
    /// @notice The mandate is past `expiresAt` and is permanently dead.
    error MandateExpired(uint64 expiresAt, uint256 blockTimestamp);
    /// @notice The mandate is cancelled: raised by every mutator on a cancelled mandate.
    /// @dev Named `MandateIsCancelled` rather than `MandateCancelled` because Solidity draws
    ///      events and errors from one namespace. See docs/decisions/001-mandate-cancelled-naming.md.
    error MandateIsCancelled();
    /// @notice The caller may not perform this action on this mandate.
    error NotAuthorized();
    /// @notice The stream is paused.
    error MandateIsPaused();
    /// @notice `resume` on a stream that is not paused.
    error MandateNotPaused();
    /// @notice `pause` or `resume` on a periodic mandate.
    error NotStreaming();
    /// @notice The signature's deadline has passed.
    error SignatureExpired(uint256 deadline, uint256 blockTimestamp);
    /// @notice The signature does not verify for the claimed signer.
    error InvalidSignature();
    /// @notice The nonce was already used or invalidated by this signer.
    error NonceAlreadyUsed(address signer, uint256 nonce);
    /// @notice `actWithSig` was given an action code other than the three `ACTION_*` values.
    error InvalidAction(uint8 action);
    /// @notice A call inside ran out of gas. The whole call reverts rather than carry on as if the
    ///         call had failed on its own merits, so no gas limit can turn a vault's withdrawal or
    ///         a settlement into a failure, and a gas estimate covers what the work really needs.
    error InsufficientGas();

    /*//////////////////////////////////////////////////////////////
                                 MUTATORS
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a mandate paying from `msg.sender`.
    /// @return mandateId The new id. Ids start at 1, so `0` is never a mandate.
    function createMandate(Terms calldata terms) external returns (uint256 mandateId);

    /// @notice Create a mandate paying from `payer`, authorized by the payer's EIP-712 signature
    ///         over `terms`, `nonce` and `deadline`. Anyone may submit it, which is what lets a
    ///         payer who holds no gas token install a mandate.
    /// @param signature An ECDSA signature, or an ERC-1271 one when `payer` is a contract.
    function createMandateWithSig(
        address payer,
        Terms calldata terms,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 mandateId);

    /// @notice Attempt the due charge. Permissionless: any caller may invoke it, which is why it
    ///         reverts `NotDue` outside the window rather than no-opping.
    /// @dev A payer short of balance or allowance gets `ChargeFailed` and no revert. A pull that
    ///      fails once attempted, because the token refuses, the vault refuses or reverts (short
    ///      of liquidity, for one) or the vault pays the wrong amount, reverts the whole charge
    ///      instead, so nothing moves and nothing is booked.
    function charge(uint256 mandateId) external;

    /// @notice Cancel a mandate. Callable by the payer, the merchant or the manager. A stream
    ///         first settles what has accrued, best effort, so time used is paid for.
    function cancelMandate(uint256 mandateId) external;

    /// @notice Pause a stream. Callable by the payer or the manager. Settles what has accrued
    ///         first, best effort.
    function pauseMandate(uint256 mandateId) external;

    /// @notice Resume a paused stream. Callable by the payer or the manager.
    function resumeMandate(uint256 mandateId) external;

    /// @notice Replace the manager key. Callable by the payer only.
    function setManager(uint256 mandateId, address manager) external;

    /// @notice A cancel, pause or resume authorized by the payer's or the manager's signature.
    /// @param action `ACTION_CANCEL`, `ACTION_PAUSE` or `ACTION_RESUME`.
    function actWithSig(
        uint256 mandateId,
        uint8 action,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice `setManager`, authorized by the payer's signature.
    function setManagerWithSig(
        uint256 mandateId,
        address manager,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Burn a nonce so no signature carrying it can ever be used.
    function invalidateNonce(uint256 nonce) external;

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The full mandate record, or a zero-filled struct for an unknown id.
    function getMandate(uint256 mandateId) external view returns (Mandate memory);

    /// @notice Whether a charge right now would pass every check on the terms: the mandate
    ///         exists, is not cancelled, paused or expired, something is due, and the lifetime
    ///         cap has room for it.
    /// @dev Deliberately ignores balance and allowance: a `Delinquent` mandate is still
    ///      chargeable, and folding funding into this answer would stop keepers retrying.
    function isChargeable(uint256 mandateId) external view returns (bool);

    /// @notice What a charge would take right now, or zero when `isChargeable` is false.
    function quoteCharge(uint256 mandateId) external view returns (uint256 amount);

    /// @notice Whether `asset` may be charged. Fixed at deployment.
    function isAcceptedAsset(address asset) external view returns (bool);

    /// @notice Every accepted asset, in deployment order.
    function acceptedAssets() external view returns (address[] memory);

    /// @notice Whether `signer` has used or invalidated `nonce`.
    function nonceUsed(address signer, uint256 nonce) external view returns (bool);

    /// @notice The EIP-712 digest a payer signs for `createMandateWithSig`.
    function hashCreate(address payer, Terms calldata terms, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32);

    /// @notice The EIP-712 digest for `actWithSig`.
    function hashAction(uint256 mandateId, uint8 action, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32);

    /// @notice The EIP-712 digest for `setManagerWithSig`.
    function hashSetManager(uint256 mandateId, address manager, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32);

    /// @notice The id the next created mandate will receive.
    function nextMandateId() external view returns (uint256);
}
