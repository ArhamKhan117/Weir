// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    IMandateMeter,
    METER_REASON_INSUFFICIENT_BALANCE,
    METER_REASON_INSUFFICIENT_ALLOWANCE
} from "./interfaces/IMandateMeter.sol";

/// @title MandateMeter
/// @notice Pay-per-use under a standing, capped authorization: the payer approves once, then signs
///         a running total per request, and the merchant is paid that total, within the caps.
/// @dev The same stance as `MandateHub`: no owner, no pause switch, no upgrade path, no fee, and
///      never a balance. The only value-moving operation is one `transferFrom` of the asset from
///      the payer to the merchant fixed at creation.
///
///      What is enforced here, and what is not. A receipt is the payer's (or their manager's)
///      signature over a running total, so the merchant can never be paid more than the payer
///      signed for, and the caps bound even that: at most `periodCap` in any period, at most
///      `maxTotal` ever. The price of each request is agreed off chain; the payer's client signs
///      a new total only for a price it accepts, which is where a per-request limit belongs.
///      Settling is idempotent in the total: a receipt for a total already paid moves nothing, so
///      receipts need no nonces and can be settled by anyone, in any order, as often as they like.
///
///      Ending a meter stops new usage, not old debt: receipts issued up to the moment it was
///      cancelled, or up to its expiry, still settle, because they are for service already given.
contract MandateMeter is IMandateMeter, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Shortest permitted period, one minute.
    uint32 public constant MIN_PERIOD = 60;

    /// @notice Longest permitted period, one 365-day year.
    uint32 public constant MAX_PERIOD = 31_536_000;

    /// @notice EIP-712 type of the terms a payer signs.
    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "MeterTerms(address merchant,address asset,address manager,uint96 periodCap,uint32 period,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );

    /// @notice EIP-712 type of a signed meter creation, with the terms nested.
    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "MeterAuthorization(address payer,MeterTerms terms,uint256 nonce,uint256 deadline)MeterTerms(address merchant,address asset,address manager,uint96 periodCap,uint32 period,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );

    /// @notice EIP-712 type of a usage receipt.
    bytes32 public constant RECEIPT_TYPEHASH = keccak256("UsageReceipt(uint256 meterId,uint96 total,uint64 issuedAt)");

    /// @notice EIP-712 type of a signed cancellation.
    bytes32 public constant CANCEL_TYPEHASH = keccak256("MeterCancel(uint256 meterId,uint256 nonce,uint256 deadline)");

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateMeter
    uint256 public override nextMeterId = 1;

    mapping(uint256 meterId => Meter) private _meters;

    /// @dev Written once in the constructor. There is no setter.
    mapping(address asset => bool) private _accepted;
    address[] private _assets;

    /// @dev Unordered nonces, one namespace per signer, for creations and cancellations.
    mapping(address signer => mapping(uint256 nonce => bool)) private _nonceUsed;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param name EIP-712 domain name, the product name a signing screen shows.
    /// @param version EIP-712 domain version.
    /// @param assets The tokens meters may pay in, fixed for the life of the contract. Each must be
    ///        a plain ERC-20 that moves exactly the amount asked.
    constructor(string memory name, string memory version, address[] memory assets) EIP712(name, version) {
        if (assets.length == 0) revert InvalidAsset(address(0));
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (asset == address(0) || _accepted[asset]) revert InvalidAsset(asset);
            // forge-lint: disable-next-line(costly-loop)
            _accepted[asset] = true;
            _assets.push(asset);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateMeter
    function createMeter(Terms calldata terms) external override returns (uint256 meterId) {
        return _create(msg.sender, terms);
    }

    /// @inheritdoc IMandateMeter
    function createMeterWithSig(
        address payer,
        Terms calldata terms,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override returns (uint256 meterId) {
        _checkDeadline(deadline);
        _verify(payer, _hashCreate(payer, terms, nonce, deadline), signature);
        _useNonce(payer, nonce);
        return _create(payer, terms);
    }

    /*//////////////////////////////////////////////////////////////
                                SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateMeter
    function settle(Receipt calldata receipt, bytes calldata signature)
        external
        override
        nonReentrant
        returns (uint256 amount)
    {
        Meter storage m = _meters[receipt.meterId];
        if (m.payer == address(0)) revert UnknownMeter();

        if (receipt.issuedAt > block.timestamp) revert ReceiptFromTheFuture(receipt.issuedAt, block.timestamp);
        uint64 lastHonored = _lastHonored(m);
        if (receipt.issuedAt > lastHonored) revert ReceiptTooLate(receipt.issuedAt, lastHonored);
        _verifyReceipt(m, receipt, signature);

        _roll(m);
        amount = _payableOf(receipt.total, m.totalCharged, m.periodCharged, m.periodCap, m.maxTotal);
        if (amount == 0) revert NothingToSettle();

        uint8 shortfall = _shortfall(m, amount);
        if (shortfall != 0) {
            if (m.status == Status.Active) m.status = Status.Delinquent;
            emit SettleFailed(receipt.meterId, shortfall, amount);
            return 0; // No revert: a batch of settlements carries on, and this one stays retryable.
        }

        // Booked before the pull: the pull is one `transferFrom` on an accepted asset, and the
        // lock is held, so nothing can observe the meter in between.
        // `amount` is at most what is left of `maxTotal`, itself a uint96.
        uint96 paid = SafeCast.toUint96(amount);
        m.totalCharged += paid;
        m.periodCharged += paid;
        if (m.status == Status.Delinquent) m.status = Status.Active;

        // The payer authorized exactly this, by signing the meter's terms and then the receipt.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(m.asset).safeTransferFrom(m.payer, m.merchant, amount);

        // forge-lint: disable-next-line(reentrancy-events)
        emit UsageSettled(receipt.meterId, m.merchant, amount, m.totalCharged, receipt.total);
    }

    /*//////////////////////////////////////////////////////////////
                                LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateMeter
    function cancel(uint256 meterId) external override {
        _cancel(meterId, msg.sender, true);
    }

    /// @inheritdoc IMandateMeter
    function cancelWithSig(uint256 meterId, address signer, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        override
    {
        _checkDeadline(deadline);
        _verify(signer, _hashCancel(meterId, nonce, deadline), signature);
        _useNonce(signer, nonce);
        // The merchant can cancel directly; a signed cancellation is the payer's side only.
        _cancel(meterId, signer, false);
    }

    /// @inheritdoc IMandateMeter
    function invalidateNonce(uint256 nonce) external override {
        _useNonce(msg.sender, nonce);
        emit NonceInvalidated(msg.sender, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateMeter
    function getMeter(uint256 meterId) external view override returns (Meter memory) {
        return _meters[meterId];
    }

    /// @inheritdoc IMandateMeter
    function settleable(uint256 meterId, uint96 total) external view override returns (uint256) {
        Meter storage m = _meters[meterId];
        if (m.payer == address(0)) return 0;

        uint96 periodCharged = block.timestamp >= uint256(m.periodStart) + m.period ? 0 : m.periodCharged;
        return _payableOf(total, m.totalCharged, periodCharged, m.periodCap, m.maxTotal);
    }

    /// @inheritdoc IMandateMeter
    function isAcceptedAsset(address asset) external view override returns (bool) {
        return _accepted[asset];
    }

    /// @inheritdoc IMandateMeter
    function acceptedAssets() external view override returns (address[] memory) {
        return _assets;
    }

    /// @inheritdoc IMandateMeter
    function nonceUsed(address signer, uint256 nonce) external view override returns (bool) {
        return _nonceUsed[signer][nonce];
    }

    /// @inheritdoc IMandateMeter
    function hashCreate(address payer, Terms calldata terms, uint256 nonce, uint256 deadline)
        external
        view
        override
        returns (bytes32)
    {
        return _hashCreate(payer, terms, nonce, deadline);
    }

    /// @inheritdoc IMandateMeter
    function hashReceipt(Receipt calldata receipt) external view override returns (bytes32) {
        return _hashReceipt(receipt);
    }

    /// @inheritdoc IMandateMeter
    function hashCancel(uint256 meterId, uint256 nonce, uint256 deadline) external view override returns (bytes32) {
        return _hashCancel(meterId, nonce, deadline);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _create(address payer, Terms calldata t) internal returns (uint256 meterId) {
        if (t.merchant == address(0) || t.merchant == address(this)) revert InvalidMerchant();
        if (!_accepted[t.asset]) revert InvalidAsset(t.asset);
        if (t.period < MIN_PERIOD || t.period > MAX_PERIOD) revert InvalidPeriod();
        if (t.maxTotal == 0) revert InvalidTotalCap();
        if (t.periodCap == 0 || t.periodCap > t.maxTotal) revert InvalidPeriodCap();
        if (t.expiresAt <= block.timestamp) revert InvalidExpiry();

        meterId = nextMeterId++;
        uint64 start = _now();
        _meters[meterId] = Meter({
            payer: payer,
            expiresAt: t.expiresAt,
            period: t.period,
            status: Status.Active,
            merchant: t.merchant,
            periodStart: start,
            asset: t.asset,
            periodCap: t.periodCap,
            manager: t.manager,
            maxTotal: t.maxTotal,
            totalCharged: 0,
            periodCharged: 0,
            closedAt: 0
        });

        emit MeterCreated(
            meterId, payer, t.merchant, t.asset, t.manager, t.periodCap, t.period, t.maxTotal, t.expiresAt, t.ref
        );
    }

    function _cancel(uint256 meterId, address by, bool merchantMay) internal {
        Meter storage m = _meters[meterId];
        if (m.payer == address(0)) revert UnknownMeter();
        bool allowed =
            by == m.payer || (m.manager != address(0) && by == m.manager) || (merchantMay && by == m.merchant);
        if (!allowed) revert NotAuthorized();
        if (m.status == Status.Cancelled) revert MeterIsCancelled();

        m.status = Status.Cancelled;
        m.closedAt = _now();
        emit MeterCancelled(meterId, by);
    }

    /// @dev Starts a new period when the current one has run out, aligned to the meter's first one.
    function _roll(Meter storage m) internal {
        uint256 start = m.periodStart;
        if (block.timestamp < start + m.period) return;
        // The latest boundary at or before now: `start` plus a whole number of periods. The
        // modulo is calendar arithmetic, not randomness.
        // forge-lint: disable-next-line(weak-prng)
        m.periodStart = SafeCast.toUint64(block.timestamp - (block.timestamp - start) % m.period);
        m.periodCharged = 0;
    }

    /// @dev What `total` still owes, held to what is left of this period's cap and the lifetime cap.
    function _payableOf(uint96 total, uint96 totalCharged, uint96 periodCharged, uint96 periodCap, uint96 maxTotal)
        internal
        pure
        returns (uint256)
    {
        if (total <= totalCharged) return 0;
        uint256 owed = total - totalCharged;
        uint256 periodLeft = periodCap > periodCharged ? periodCap - periodCharged : 0;
        uint256 totalLeft = maxTotal > totalCharged ? maxTotal - totalCharged : 0;
        return Math.min(owed, Math.min(periodLeft, totalLeft));
    }

    /// @dev The latest `issuedAt` still honored: the expiry, or the cancellation if earlier.
    function _lastHonored(Meter storage m) internal view returns (uint64) {
        uint64 last = m.expiresAt;
        if (m.closedAt != 0 && m.closedAt < last) last = m.closedAt;
        return last;
    }

    function _shortfall(Meter storage m, uint256 amount) internal view returns (uint8) {
        IERC20 asset = IERC20(m.asset);
        if (asset.balanceOf(m.payer) < amount) return METER_REASON_INSUFFICIENT_BALANCE;
        if (asset.allowance(m.payer, address(this)) < amount) return METER_REASON_INSUFFICIENT_ALLOWANCE;
        return 0;
    }

    /// @dev A receipt is the payer's, or the manager's when there is one.
    function _verifyReceipt(Meter storage m, Receipt calldata receipt, bytes calldata signature) internal view {
        bytes32 digest = _hashReceipt(receipt);
        if (m.manager != address(0) && SignatureChecker.isValidSignatureNow(m.manager, digest, signature)) return;
        if (SignatureChecker.isValidSignatureNow(m.payer, digest, signature)) return;
        revert InvalidSignature();
    }

    /// @dev The block timestamp as the 64-bit width every stored time uses.
    function _now() internal view returns (uint64) {
        return SafeCast.toUint64(block.timestamp);
    }

    function _useNonce(address signer, uint256 nonce) internal {
        if (_nonceUsed[signer][nonce]) revert NonceAlreadyUsed(signer, nonce);
        _nonceUsed[signer][nonce] = true;
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
    }

    function _verify(address signer, bytes32 digest, bytes calldata signature) internal view {
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature();
    }

    function _hashCreate(address payer, Terms calldata terms, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        // `Terms` holds only static members, so its ABI encoding is exactly its EIP-712
        // `encodeData`: one 32-byte word per member, in declaration order.
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 termsHash = keccak256(abi.encode(TERMS_TYPEHASH, terms));
        return _hashTypedDataV4(keccak256(abi.encode(AUTHORIZATION_TYPEHASH, payer, termsHash, nonce, deadline)));
    }

    function _hashReceipt(Receipt calldata receipt) internal view returns (bytes32) {
        return
            _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, receipt.meterId, receipt.total, receipt.issuedAt)));
    }

    function _hashCancel(uint256 meterId, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, meterId, nonce, deadline)));
    }
}
