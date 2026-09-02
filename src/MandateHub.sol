// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE,
    REASON_TRANSFER_REFUSED,
    ACTION_CANCEL,
    ACTION_PAUSE,
    ACTION_RESUME
} from "./interfaces/IMandateHub.sol";

/// @title MandateHub
/// @notice Standing, capped, expiring pull payments in dollar stablecoins.
/// @dev Deliberately minimal in authority: no owner, no pause switch, no upgrade path, no fee.
///      The terms recorded at creation are the only policy the contract enforces, so there is no
///      privileged party that can redirect, widen or freeze an existing mandate.
///
///      Non-custodial by construction. The hub never holds a balance: the only value-moving
///      operation anywhere in it is one pull from the payer to the merchant recorded at creation,
///      a `transferFrom` of the asset or, for a mandate drawn from a vault, a
///      `withdraw(amount, merchant, payer)` on it. When that vault cannot pay, the same amount
///      comes from the payer's balance of the asset instead, under the same caps: the merchant is
///      paid whenever the payer has the money in either place. Revoking the allowances stops every
///      future charge without asking the hub.
///
///      The hub cannot tell a passkey-derived key from any other key, or an EOA from a smart
///      account: `payer` is `msg.sender` on the direct path and the verified signer on the signed
///      path, and signatures are checked with ERC-1271 support. That keeps it testable in
///      isolation and usable by any wallet.
contract MandateHub is IMandateHub, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Shortest permitted period for a periodic mandate.
    uint32 public constant MIN_PERIOD = 60;

    /// @notice Longest permitted period for a periodic mandate, one 365-day year.
    uint32 public constant MAX_PERIOD = 31_536_000;

    /// @dev The `period` value that marks a streaming mandate.
    uint32 private constant STREAMING = 0;

    /// @dev A failed call that leaves less than `1 / STARVED_SHARE` of the gas it was made with
    ///      is taken as starved rather than refused. See `_revertIfStarved`.
    uint256 private constant STARVED_SHARE = 6;

    /// @notice EIP-712 type of the terms a payer signs.
    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );

    /// @notice EIP-712 type of a signed mandate creation. `Terms` is nested so a signing screen
    ///         can show the terms as one block.
    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address payer,Terms terms,uint256 nonce,uint256 deadline)Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );

    /// @notice EIP-712 type of a signed cancel, pause or resume.
    bytes32 public constant ACTION_TYPEHASH =
        keccak256("MandateAction(uint256 mandateId,uint8 action,uint256 nonce,uint256 deadline)");

    /// @notice EIP-712 type of a signed manager change.
    bytes32 public constant SET_MANAGER_TYPEHASH =
        keccak256("SetManager(uint256 mandateId,address manager,uint256 nonce,uint256 deadline)");

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateHub
    uint256 public override nextMandateId = 1;

    mapping(uint256 mandateId => Mandate) private _mandates;

    /// @dev Written once in the constructor. There is no setter.
    mapping(address asset => bool) private _accepted;
    address[] private _assets;

    /// @dev Unordered nonces, one namespace per signer across every signed entry point, so two
    ///      checkouts signed at once never invalidate each other.
    mapping(address signer => mapping(uint256 nonce => bool)) private _nonceUsed;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param name EIP-712 domain name, the product name a signing screen shows.
    /// @param version EIP-712 domain version.
    /// @param assets The tokens mandates may charge, fixed for the life of the contract. Each must
    ///        be a plain ERC-20 that moves exactly the amount asked, which the dollar stablecoins
    ///        this is built for do.
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

    /// @inheritdoc IMandateHub
    function createMandate(Terms calldata terms) external override returns (uint256 mandateId) {
        return _create(msg.sender, terms);
    }

    /// @inheritdoc IMandateHub
    function createMandateWithSig(
        address payer,
        Terms calldata terms,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override returns (uint256 mandateId) {
        _checkDeadline(deadline);
        _verify(payer, _hashCreate(payer, terms, nonce, deadline), signature);
        _useNonce(payer, nonce);
        return _create(payer, terms);
    }

    /*//////////////////////////////////////////////////////////////
                                 CHARGING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateHub
    function charge(uint256 mandateId) external override nonReentrant {
        Mandate storage m = _mandates[mandateId];

        _requireLive(m);
        if (m.pausedAt != 0) revert MandateIsPaused();

        uint256 amount = _due(m);

        (uint8 shortfall, bool fromBalance) = _collect(mandateId, m, amount);
        // Only a pull that happened may be booked, so this follows it by design, as in `_settle`.
        // The reentrancy lock is held and the pull reaches only the payer's own token or vault.
        if (shortfall != 0) {
            if (m.status != Status.Delinquent) m.status = Status.Delinquent;
            // forge-lint: disable-next-line(reentrancy-events)
            emit ChargeFailed(mandateId, shortfall, amount);
            return; // No revert: the schedule and totals stay exactly retryable.
        }

        uint64 next = _book(m, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        if (fromBalance) emit ChargedFromBalance(mandateId, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Charged(mandateId, m.merchant, amount, m.totalCharged, next);
    }

    /*//////////////////////////////////////////////////////////////
                                LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateHub
    function cancelMandate(uint256 mandateId) external override nonReentrant {
        _cancel(mandateId, msg.sender);
    }

    /// @inheritdoc IMandateHub
    function pauseMandate(uint256 mandateId) external override nonReentrant {
        _pause(mandateId, msg.sender);
    }

    /// @inheritdoc IMandateHub
    function resumeMandate(uint256 mandateId) external override {
        _resume(mandateId, msg.sender);
    }

    /// @inheritdoc IMandateHub
    function setManager(uint256 mandateId, address manager) external override {
        _setManager(mandateId, msg.sender, manager);
    }

    /// @inheritdoc IMandateHub
    function actWithSig(
        uint256 mandateId,
        uint8 action,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override nonReentrant {
        _checkDeadline(deadline);
        _verify(signer, _hashAction(mandateId, action, nonce, deadline), signature);
        _useNonce(signer, nonce);

        if (action == ACTION_CANCEL) _cancel(mandateId, signer);
        else if (action == ACTION_PAUSE) _pause(mandateId, signer);
        else if (action == ACTION_RESUME) _resume(mandateId, signer);
        else revert InvalidAction(action);
    }

    /// @inheritdoc IMandateHub
    function setManagerWithSig(
        uint256 mandateId,
        address manager,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override {
        address payer = _mandates[mandateId].payer;
        if (payer == address(0)) revert UnknownMandate();

        _checkDeadline(deadline);
        _verify(payer, _hashSetManager(mandateId, manager, nonce, deadline), signature);
        _useNonce(payer, nonce);
        _setManager(mandateId, payer, manager);
    }

    /// @notice The settlement's collection, as an external call so any failure inside can be caught
    ///         and rolled back whole. Callable only by the hub itself.
    /// @dev `_settle` must never fail on the payer's account, and the token it falls back to can
    ///      still refuse. One external self-call covers that, and `_settle` reports any revert out
    ///      of it as `REASON_TRANSFER_REFUSED`.
    /// @return shortfall Zero when the pull happened, otherwise the `REASON_*` code for why the
    ///         payer could not fund it, in which case nothing moved.
    /// @return fromBalance True when a mandate drawn from a vault was paid from the balance instead.
    function pullForSettlement(uint256 mandateId, uint256 amount) external returns (uint8 shortfall, bool fromBalance) {
        if (msg.sender != address(this)) revert NotAuthorized();
        return _collect(mandateId, _mandates[mandateId], amount);
    }

    /// @notice One attempt to pay `amount` from a mandate's vault, as an external call so any
    ///         failure inside can be caught and rolled back whole. Callable only by the hub itself.
    /// @dev Everything here is the vault's to get wrong: it can refuse the withdrawal (short of
    ///      liquidity, for one), pay the wrong amount, or fail to answer `previewWithdraw`,
    ///      `balanceOf` or `allowance` at all. The exact-amount check after the withdrawal also has
    ///      to be able to undo it. `_collect` treats any revert out of here as the vault refusing,
    ///      and moves on to the payer's balance.
    /// @return shortfall Zero when the vault paid, otherwise the `REASON_*` code for why the
    ///         payer's savings could not fund it, in which case nothing moved.
    function pullFromVault(uint256 mandateId, uint256 amount) external returns (uint8 shortfall) {
        if (msg.sender != address(this)) revert NotAuthorized();
        Mandate storage m = _mandates[mandateId];

        shortfall = _vaultShortfall(m, amount);
        if (shortfall == 0) _withdraw(m, amount);
    }

    /// @inheritdoc IMandateHub
    function invalidateNonce(uint256 nonce) external override {
        _useNonce(msg.sender, nonce);
        emit NonceInvalidated(msg.sender, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMandateHub
    function getMandate(uint256 mandateId) external view override returns (Mandate memory) {
        return _mandates[mandateId];
    }

    /// @inheritdoc IMandateHub
    function isChargeable(uint256 mandateId) public view override returns (bool) {
        Mandate storage m = _mandates[mandateId];

        if (m.payer == address(0) || m.status == Status.Cancelled) return false;
        if (m.pausedAt != 0 || block.timestamp > m.expiresAt) return false;

        if (m.period == STREAMING) return block.timestamp > m.nextChargeAt && m.totalCharged < m.maxTotal;
        return block.timestamp >= m.nextChargeAt && uint256(m.totalCharged) + m.amount <= m.maxTotal;
    }

    /// @inheritdoc IMandateHub
    function quoteCharge(uint256 mandateId) external view override returns (uint256) {
        if (!isChargeable(mandateId)) return 0;

        Mandate storage m = _mandates[mandateId];
        return m.period == STREAMING ? _streamAmount(m) : m.amount;
    }

    /// @inheritdoc IMandateHub
    function isAcceptedAsset(address asset) external view override returns (bool) {
        return _accepted[asset];
    }

    /// @inheritdoc IMandateHub
    function acceptedAssets() external view override returns (address[] memory) {
        return _assets;
    }

    /// @inheritdoc IMandateHub
    function nonceUsed(address signer, uint256 nonce) external view override returns (bool) {
        return _nonceUsed[signer][nonce];
    }

    /// @inheritdoc IMandateHub
    function hashCreate(address payer, Terms calldata terms, uint256 nonce, uint256 deadline)
        external
        view
        override
        returns (bytes32)
    {
        return _hashCreate(payer, terms, nonce, deadline);
    }

    /// @inheritdoc IMandateHub
    function hashAction(uint256 mandateId, uint8 action, uint256 nonce, uint256 deadline)
        external
        view
        override
        returns (bytes32)
    {
        return _hashAction(mandateId, action, nonce, deadline);
    }

    /// @inheritdoc IMandateHub
    function hashSetManager(uint256 mandateId, address manager, uint256 nonce, uint256 deadline)
        external
        view
        override
        returns (bytes32)
    {
        return _hashSetManager(mandateId, manager, nonce, deadline);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNALS: MUTATION
    //////////////////////////////////////////////////////////////*/

    function _create(address payer, Terms calldata t) internal returns (uint256 mandateId) {
        bool streaming = t.period == STREAMING;

        if (!_accepted[t.asset]) revert InvalidAsset(t.asset);
        if (t.vault != address(0) && !_isVaultOver(t.vault, t.asset)) revert InvalidVault(t.vault);
        // The hub itself is refused too: nothing here can ever pay a balance back out of it.
        if (t.merchant == address(0) || t.merchant == payer || t.merchant == address(this)) revert InvalidMerchant();
        if (t.amount == 0) revert InvalidAmount();
        if (!streaming && (t.period < MIN_PERIOD || t.period > MAX_PERIOD)) revert InvalidPeriod();
        if (t.maxPerCharge == 0 || (!streaming && t.maxPerCharge < t.amount)) revert InvalidChargeCap();
        if (t.maxTotal == 0 || (!streaming && t.maxTotal < t.amount)) revert InvalidTotalCap();

        // A periodic mandate keeps a past `startAt` as the anchor of its schedule lattice and is
        // chargeable at once. A stream never accrues for time before it existed.
        uint64 start = t.startAt == 0 ? _now() : t.startAt;
        if (streaming && start < block.timestamp) start = _now();

        if (t.expiresAt <= block.timestamp || start > t.expiresAt || (streaming && start == t.expiresAt)) {
            revert InvalidExpiry();
        }

        mandateId = nextMandateId++;

        Mandate storage m = _mandates[mandateId];
        m.payer = payer;
        m.nextChargeAt = start;
        m.period = t.period;
        m.merchant = t.merchant;
        m.expiresAt = t.expiresAt;
        m.status = Status.Active;
        m.asset = t.asset;
        m.amount = t.amount;
        m.manager = t.manager;
        m.maxPerCharge = t.maxPerCharge;
        m.maxTotal = t.maxTotal;
        m.vault = t.vault;

        _emitCreated(mandateId, payer, t, start);
    }

    function _emitCreated(uint256 mandateId, address payer, Terms calldata t, uint64 start) private {
        emit MandateCreated(
            mandateId,
            payer,
            t.merchant,
            t.asset,
            t.vault,
            t.manager,
            t.amount,
            t.period,
            start,
            t.maxPerCharge,
            t.maxTotal,
            t.expiresAt,
            t.ref
        );
    }

    /// @dev Records a successful charge: advances the schedule or the checkpoint, adds to the
    ///      total, and clears delinquency. Returns the new `nextChargeAt`.
    function _book(Mandate storage m, uint256 amount) internal returns (uint64 next) {
        next = m.period == STREAMING ? _now() : _advance(m.nextChargeAt, m.period);
        m.nextChargeAt = next;
        m.totalCharged += SafeCast.toUint96(amount);
        if (m.status != Status.Active) m.status = Status.Active;
    }

    function _cancel(uint256 mandateId, address by) internal {
        Mandate storage m = _mandates[mandateId];

        if (m.payer == address(0)) revert UnknownMandate();
        if (by != m.payer && by != m.merchant && (by != m.manager || by == address(0))) revert NotAuthorized();
        if (m.status == Status.Cancelled) revert MandateIsCancelled();

        if (m.period == STREAMING && m.pausedAt == 0) _settle(mandateId, m);
        m.status = Status.Cancelled;

        // After the settlement's pull by design, so the log reads in the order things happened.
        // The reentrancy lock is held and the pull reaches only the payer's own token or vault.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MandateCancelled(mandateId, by);
    }

    function _pause(uint256 mandateId, address by) internal {
        Mandate storage m = _requireStreamController(mandateId, by);
        if (m.pausedAt != 0) revert MandateIsPaused();

        _settle(mandateId, m);
        m.pausedAt = _now();

        // As in `_cancel`: after the settlement's pull by design, under the reentrancy lock.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MandatePaused(mandateId, by);
    }

    function _resume(uint256 mandateId, address by) internal {
        Mandate storage m = _requireStreamController(mandateId, by);
        uint64 pausedAt = m.pausedAt;
        if (pausedAt == 0) revert MandateNotPaused();

        // Shift the checkpoint by the part of the pause that was billable time, so paused time is
        // never billed and anything accrued before the pause that its settlement could not collect
        // stays owed. Pause time before the checkpoint (a stream paused before its start) was never
        // billable, so it moves nothing: the stream starts at `max(start, resume)`.
        uint64 billableFrom = pausedAt > m.nextChargeAt ? pausedAt : m.nextChargeAt;
        uint64 now_ = _now();
        if (now_ > billableFrom) m.nextChargeAt += now_ - billableFrom;
        m.pausedAt = 0;

        emit MandateResumed(mandateId, by);
    }

    function _setManager(uint256 mandateId, address by, address manager) internal {
        Mandate storage m = _mandates[mandateId];

        if (m.payer == address(0)) revert UnknownMandate();
        if (by != m.payer) revert NotAuthorized();
        if (m.status == Status.Cancelled) revert MandateIsCancelled();

        m.manager = manager;
        emit ManagerChanged(mandateId, manager);
    }

    /// @dev Collects what a running stream has accrued before it pauses or ends. Never reverts on
    ///      the payer's account: a payer must always be able to stop a stream, so a shortfall or
    ///      a refused transfer is reported with `ChargeFailed` and the stop goes ahead.
    ///
    ///      The pull runs before the bookkeeping here, the reverse of `charge`, because only a pull
    ///      that actually happened may be booked. Every caller holds the reentrancy lock, which the
    ///      self-call into `pullForSettlement` does not need and does not take.
    function _settle(uint256 mandateId, Mandate storage m) internal {
        if (block.timestamp > m.expiresAt || block.timestamp <= m.nextChargeAt) return;
        if (m.totalCharged >= m.maxTotal) return;

        uint256 amount = _streamAmount(m);

        uint8 shortfall = 0;
        bool fromBalance = false;
        uint256 gasBefore = gasleft();
        try this.pullForSettlement(mandateId, amount) returns (uint8 code, bool fromVaultFallback) {
            (shortfall, fromBalance) = (code, fromVaultFallback);
        } catch (bytes memory reason) {
            // Starved, not refused: a stop must not skip what the stream owes for want of gas.
            _revertIfStarved(gasBefore, reason);
            // The token refused or reverted, and the self-call undid everything it had done.
            shortfall = REASON_TRANSFER_REFUSED;
        }
        // Only a pull that happened may be booked, so these follow it by design. The reentrancy lock
        // is held and the pull reaches only the payer's own token or vault.
        if (shortfall != 0) {
            if (m.status != Status.Delinquent) m.status = Status.Delinquent;
            // forge-lint: disable-next-line(reentrancy-events)
            emit ChargeFailed(mandateId, shortfall, amount);
            return;
        }

        uint64 next = _book(m, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        if (fromBalance) emit ChargedFromBalance(mandateId, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Charged(mandateId, m.merchant, amount, m.totalCharged, next);
    }

    /// @dev Moves exactly `amount` from the payer to the merchant, or reports why it cannot.
    ///
    ///      A mandate drawn from a vault is paid from it whenever it can pay, so savings earn until
    ///      the moment a charge is due. When it cannot, whatever the reason, the same amount comes
    ///      from the payer's balance of the asset, which the payer allowed the hub as a backup at
    ///      install: a direct debit's job is to pay on time, and the money is the payer's either
    ///      way, under the same caps. When neither can pay, the vault's reason is the one reported,
    ///      since the vault is where the payer chose to pay from, and nothing has moved.
    ///
    ///      Forcing the fallback by starving the vault attempt of gas does not work: an attempt
    ///      that ran out of gas reverts the whole charge (`_revertIfStarved`) instead of falling
    ///      back, so a gas estimate has to cover the withdrawal.
    ///
    ///      A pull payment moves funds from someone other than the caller by definition: `payer`
    ///      signed or sent the terms, and the terms bound what may move and to whom. The allowlist
    ///      admits only plain tokens that move exactly what is asked, so the direct transfer needs
    ///      no receipt check; a vault is the payer's own choice and gets one, in `_withdraw`.
    /// @return shortfall Zero when the pull happened, otherwise the `REASON_*` code.
    /// @return fromBalance True when a mandate drawn from a vault was paid from the balance instead.
    function _collect(uint256 mandateId, Mandate storage m, uint256 amount)
        internal
        returns (uint8 shortfall, bool fromBalance)
    {
        if (m.vault != address(0)) {
            uint256 gasBefore = gasleft();
            try this.pullFromVault(mandateId, amount) returns (uint8 code) {
                shortfall = code;
            } catch (bytes memory reason) {
                // Starved, not refused: no gas limit may push a charge onto the balance.
                _revertIfStarved(gasBefore, reason);
                // The vault refused, reverted or paid the wrong amount, and the self-call undid
                // everything it had done.
                shortfall = REASON_TRANSFER_REFUSED;
            }
            // Paid from savings, or neither source can pay and the vault's reason stands.
            if (shortfall == 0 || _balanceShortfall(m, amount) != 0) return (shortfall, fromBalance);
            shortfall = 0;
            fromBalance = true;
        } else {
            shortfall = _balanceShortfall(m, amount);
            if (shortfall != 0) return (shortfall, fromBalance);
        }

        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(m.asset).safeTransferFrom(m.payer, m.merchant, amount);
    }

    /// @dev Reverts when the call that just failed ran out of gas rather than failed on its own.
    ///      Each frame keeps back a sixty-fourth of its gas from the call it makes (EIP-150) and
    ///      hands it back when that call fails, so a call starved `k` frames down leaves its caller
    ///      roughly `k` sixty-fourths of what it had. A vault's withdrawal can run several frames
    ///      deep (vault, adapter, market, token), so anything under a sixth is taken as starved,
    ///      which covers about ten frames. A refusal on its own merits is cheap and leaves far
    ///      more at any reasonable limit; at worst it is mistaken for starvation at a limit too
    ///      tight to leave a sixth, which only reverts the call and raises the estimate. A call
    ///      that failed because something inside it was starved says so with `InsufficientGas`,
    ///      which is passed on. Telling these apart is what keeps a tight gas limit, or a gas
    ///      estimate searching for the lowest one, from turning a vault's withdrawal or a stream's
    ///      settlement into a failure. A vault that reverts with `InsufficientGas` itself is
    ///      treated as starved, so its charge reverts rather than fall back: the vault is the
    ///      payer's own choice.
    function _revertIfStarved(uint256 gasBefore, bytes memory reason) internal view {
        if (gasleft() < gasBefore / STARVED_SHARE || _isInsufficientGas(reason)) revert InsufficientGas();
    }

    /// @dev Whether `reason` is exactly the revert data of `InsufficientGas()`.
    function _isInsufficientGas(bytes memory reason) internal pure returns (bool) {
        return keccak256(reason) == keccak256(abi.encodeWithSelector(InsufficientGas.selector));
    }

    /// @dev Withdraws exactly `amount` from the mandate's vault to the merchant, or reverts.
    function _withdraw(Mandate storage m, uint256 amount) internal {
        IERC20 asset = IERC20(m.asset);
        address merchant = m.merchant;

        uint256 before = asset.balanceOf(merchant);
        // The shares burned are the vault's business and the payer's allowance bounds them; what
        // the hub guarantees is the merchant's receipt, checked next.
        // forge-lint: disable-next-line(unused-return)
        IERC4626(m.vault).withdraw(amount, merchant, m.payer);
        uint256 received = asset.balanceOf(merchant) - before;
        if (received != amount) revert PaymentMismatch(amount, received);
    }

    function _useNonce(address signer, uint256 nonce) internal {
        if (_nonceUsed[signer][nonce]) revert NonceAlreadyUsed(signer, nonce);
        _nonceUsed[signer][nonce] = true;
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNALS: CHECKS
    //////////////////////////////////////////////////////////////*/

    /// @dev Exists, is not cancelled, and is not past `expiresAt`.
    function _requireLive(Mandate storage m) internal view {
        if (m.payer == address(0)) revert UnknownMandate();
        if (m.status == Status.Cancelled) revert MandateIsCancelled();
        if (block.timestamp > m.expiresAt) revert MandateExpired(m.expiresAt, block.timestamp);
    }

    /// @dev A live stream, and `by` is its payer or its manager.
    function _requireStreamController(uint256 mandateId, address by) internal view returns (Mandate storage m) {
        m = _mandates[mandateId];

        if (m.payer == address(0)) revert UnknownMandate();
        if (by != m.payer && (by != m.manager || by == address(0))) revert NotAuthorized();
        _requireLive(m);
        if (m.period != STREAMING) revert NotStreaming();
    }

    /// @dev The amount a charge takes now, reverting when nothing is due or the lifetime cap has
    ///      no room. Assumes `_requireLive` and an unpaused mandate.
    function _due(Mandate storage m) internal view returns (uint256) {
        if (m.period == STREAMING) {
            if (block.timestamp <= m.nextChargeAt) revert NotDue(m.nextChargeAt, block.timestamp);
            if (m.totalCharged >= m.maxTotal) revert TotalCapExceeded(m.totalCharged, m.maxTotal);
            return _streamAmount(m);
        }

        if (block.timestamp < m.nextChargeAt) revert NotDue(m.nextChargeAt, block.timestamp);
        if (uint256(m.totalCharged) + m.amount > m.maxTotal) revert TotalCapExceeded(m.totalCharged, m.maxTotal);
        return m.amount;
    }

    /// @dev `amount * elapsed` since the checkpoint, clamped to the per-charge cap and to what the
    ///      lifetime cap has left. Assumes the checkpoint is in the past and the cap has room.
    ///      The product cannot overflow: 96 bits of rate times 64 bits of seconds.
    function _streamAmount(Mandate storage m) internal view returns (uint256) {
        uint256 accrued = uint256(m.amount) * (block.timestamp - m.nextChargeAt);
        return Math.min(accrued, Math.min(m.maxPerCharge, m.maxTotal - m.totalCharged));
    }

    /// @dev Zero when the payer's balance of the asset can fund `amount`, otherwise the `REASON_*`
    ///      code for why not. The asset is an accepted plain token, so its answers are trusted.
    function _balanceShortfall(Mandate storage m, uint256 amount) internal view returns (uint8) {
        IERC20 asset = IERC20(m.asset);
        if (asset.balanceOf(m.payer) < amount) return REASON_INSUFFICIENT_BALANCE;
        if (asset.allowance(m.payer, address(this)) < amount) return REASON_INSUFFICIENT_ALLOWANCE;
        return 0;
    }

    /// @dev Zero when the payer's savings in the mandate's vault can fund `amount`, otherwise the
    ///      `REASON_*` code for why not.
    ///
    ///      Both lines are drawn in shares, at `previewWithdraw(amount)`, which ERC-4626 requires to
    ///      be what `withdraw` burns in the same transaction: the payer's share balance must cover
    ///      it, and so must their share allowance to the hub. `maxWithdraw` is not read. A vault may
    ///      answer it with zero for everyone, as Morpho Vault V2 does by design, which would fail
    ///      every charge. What it could have added, the vault's own liquidity and limits, therefore
    ///      shows only as the withdrawal reverting, which `_collect` catches.
    ///
    ///      Runs only inside `pullFromVault`, so a vault that reverts here, or answers something
    ///      that does not decode, is caught the same way. One that underprices the shares gains
    ///      nothing: the vault itself spends the share allowance on `withdraw`, and `_withdraw`
    ///      checks the merchant's receipt.
    function _vaultShortfall(Mandate storage m, uint256 amount) internal view returns (uint8) {
        address vault = m.vault;
        uint256 shares = IERC4626(vault).previewWithdraw(amount);
        if (IERC20(vault).balanceOf(m.payer) < shares) return REASON_INSUFFICIENT_BALANCE;
        if (IERC20(vault).allowance(m.payer, address(this)) < shares) return REASON_INSUFFICIENT_ALLOWANCE;
        return 0;
    }

    /// @dev True when `vault` answers `asset()` with exactly `asset`. Anything else is not a vault
    ///      over it: no code, a revert, or an answer that is not a clean address, such as the empty
    ///      return of a contract with a bare fallback. A raw call rather than a typed one, because a
    ///      typed call decodes the answer in this frame and a malformed one would revert here.
    function _isVaultOver(address vault, address asset) internal view returns (bool) {
        if (vault.code.length == 0) return false;

        (bool ok, bytes memory answer) = vault.staticcall(abi.encodeCall(IERC4626.asset, ()));
        if (!ok || answer.length < 32) return false;

        uint256 word = abi.decode(answer, (uint256));
        // The cast cannot truncate: the high 96 bits were just checked to be zero.
        // forge-lint: disable-next-line(unsafe-typecast)
        return word >> 160 == 0 && address(uint160(word)) == asset;
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
    }

    function _verify(address signer, bytes32 digest, bytes calldata signature) internal view {
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature();
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNALS: ARITHMETIC
    //////////////////////////////////////////////////////////////*/

    /// @dev The first boundary of the lattice `prev + k * period` strictly after now. A charge
    ///      landing several periods late advances past every missed boundary in one step, so
    ///      missed periods are skipped rather than owed.
    function _advance(uint64 prev, uint32 period) internal view returns (uint64) {
        uint256 elapsed = block.timestamp - prev;
        uint256 k = elapsed / period + 1;

        return SafeCast.toUint64(uint256(prev) + k * uint256(period));
    }

    /// @dev The block timestamp as the 64-bit width every stored time uses.
    function _now() internal view returns (uint64) {
        return SafeCast.toUint64(block.timestamp);
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
        return _hashTypedDataV4(keccak256(abi.encode(MANDATE_TYPEHASH, payer, termsHash, nonce, deadline)));
    }

    function _hashAction(uint256 mandateId, uint8 action, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH, mandateId, action, nonce, deadline)));
    }

    function _hashSetManager(uint256 mandateId, address manager, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SET_MANAGER_TYPEHASH, mandateId, manager, nonce, deadline)));
    }
}
