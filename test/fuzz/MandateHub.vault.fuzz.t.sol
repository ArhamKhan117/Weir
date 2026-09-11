// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE,
    REASON_TRANSFER_REFUSED
} from "../../src/interfaces/IMandateHub.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {MisquotingVault} from "../mocks/MisquotingVault.sol";
import {FuzzTerms} from "./FuzzTerms.sol";

/// @dev A vault that pays the receiver one base unit more than asked, out of what its other
///      depositors hold: the other way a vault can fail to pay exactly.
contract OverpayingVault is MockVault {
    constructor(IERC20 asset_) MockVault(asset_) {}

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256 shares) {
        shares = super.withdraw(assets, receiver, owner);
        SafeERC20.safeTransfer(IERC20(asset()), receiver, 1);
    }
}

/// @title MandateHubVaultFuzzTest
/// @notice Earning until charged holds under arbitrary savings, yield and liquidity, against a
///         vault that reports its limits and against one that answers zero from every `max*` view
///         as Morpho Vault V2 does. A charge drawn from a vault moves exactly the amount due from
///         the payer's vault position to the merchant: the merchant gains exactly that, the vault
///         pays out exactly that, the payer's shares fall by exactly the vault's own
///         `previewWithdraw` of it, and the payer's wallet, every other depositor and the hub are
///         untouched. When the vault cannot pay, for any reason (shares or share allowance below
///         the `previewWithdraw` of it, short of liquidity, paying short or over, or unable to
///         answer at all), the same amount comes from the payer's balance of the asset when that
///         can pay: the merchant gains exactly it, the wallet gives exactly it, and the vault
///         position is untouched. When neither can, nothing moves and nothing is booked, and the
///         reason reported is the vault's: 1 for shares, 2 for share allowance, 3 for a vault that
///         refused. A vault can never mispay a merchant. The same holds for the settlement inside
///         pause and cancel, which stops the stream either way. The pulls answer to the hub alone.
contract MandateHubVaultFuzzTest is FuzzTerms {
    /// @dev Far enough out that no sequence here reaches expiry.
    uint64 internal constant FAR = T0 + 100 * 365 days;

    /// @dev The vault over `usd` the mandates here draw from: the one `FuzzTerms` deploys, or one
    ///      a test swaps in that pays over or stops quoting.
    MockVault internal vault;

    /// @dev Another depositor in the same vault, whose shares no charge may touch.
    address internal saver;

    /// @dev Everything a vault charge may and may not move.
    struct Position {
        uint256 merchantAssets;
        uint256 vaultAssets;
        uint256 payerShares;
        uint256 saverShares;
        uint256 shareSupply;
        uint256 payerWallet;
        uint256 payerWalletAllowance;
        uint256 hubAssets;
        uint256 hubShares;
    }

    function setUp() public override {
        super.setUp();
        vault = vaultOf[address(usd)];
        saver = makeAddr("saver");

        // The payer's wallet stays funded and approved, the backup a savings mandate falls back
        // to, unless a test takes the backup away; a charge that touched it when the vault could
        // pay would show.
        vm.prank(payer);
        vault.approve(address(hub), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                             EXACT MOVEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev Six periods; before each, arbitrary yield lands in the vault and its liquidity is
    ///      capped anywhere (or not at all). Every charge moves exactly `amount` from the vault,
    ///      or from the balance when the vault cannot pay, or reports the vault's reason and
    ///      moves nothing.
    function testFuzz_periodicChargesMoveExactlyTheAmountUnderYieldAndLiquidity(
        uint96 amount,
        uint256 saved,
        uint256 others,
        uint256[6] memory yields,
        uint256[6] memory caps,
        bool zeroMax,
        bool backup
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(backup);
        amount = uint96(bound(amount, 1, 1e15));
        _save(payer, bound(saved, 0, 1e16));
        _save(saver, bound(others, 0, 1e16));
        uint256 id = _openPeriodic(amount);

        for (uint256 i = 0; i < yields.length; ++i) {
            _yield(bound(yields[i], 0, 1e15));
            _capLiquidity(caps[i], amount);
            _chargeAndCheck(id, amount);
            vm.warp(block.timestamp + MONTH);
        }
    }

    /// @dev The same for a stream, against an independent model of what is due: the accrual
    ///      since the last successful charge, clamped to both caps.
    function testFuzz_streamChargesMoveExactlyTheAccrualUnderYieldAndLiquidity(
        uint96 rate,
        uint96 maxPerCharge,
        uint96 maxTotal,
        uint256 saved,
        uint256[6] memory yields,
        uint256[6] memory caps,
        uint32[6] memory gaps,
        uint8 modes
    ) public {
        // One argument for both switches, which keeps this test inside the stack: the vault's
        // `max*` mode in bit 0, the backup in bit 1.
        vault.setZeroMax(modes & 1 != 0);
        _backup(modes & 2 != 0);
        rate = uint96(bound(rate, 1, 1e9));
        maxPerCharge = uint96(bound(maxPerCharge, 1, 1e15));
        maxTotal = uint96(bound(maxTotal, 1, 1e16));
        _save(payer, bound(saved, 0, 1e16));
        uint256 id = _openStream(rate, maxPerCharge, maxTotal);

        uint256 checkpoint = block.timestamp;
        uint256 total;
        for (uint256 i = 0; i < gaps.length; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 1, 30 days));
            _yield(bound(yields[i], 0, 1e15));

            if (total == maxTotal) {
                vm.expectRevert(abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, total, maxTotal));
                hub.charge(id);
                continue;
            }

            uint256 due = _min(uint256(rate) * (block.timestamp - checkpoint), _min(maxPerCharge, maxTotal - total));
            _capLiquidity(caps[i], due);
            if (_chargeAndCheck(id, due)) {
                checkpoint = block.timestamp;
                total += due;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                           FUNDING BOUNDARIES
    //////////////////////////////////////////////////////////////*/

    /// @dev With no backup, the payer's shares against the vault's `previewWithdraw` of the
    ///      amount are the exact line between a charge and a reason-1 failure, whatever the
    ///      vault's `max*` views say. The position is cut to the line by moving shares to another
    ///      depositor, which leaves the share price, and so the cost, where it was.
    function testFuzz_theShareBalanceIsTheExactFundingLine(
        uint96 amount,
        uint256 extra,
        uint256 yield,
        bool onTheLine,
        bool zeroMax
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(false);
        amount = uint96(bound(amount, 1, 1e15));
        _save(payer, amount + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));
        uint256 id = _openPeriodic(amount);

        uint256 cost = vault.previewWithdraw(amount);
        _keepShares(onTheLine ? cost : cost - 1);

        assertEq(_chargeAndCheck(id, amount), onTheLine, "charged exactly when the shares cover the cost");
        if (onTheLine) assertEq(vault.balanceOf(payer), 0, "the position spent is exactly the cost");
    }

    /// @dev The vault's liquidity is the vault's to enforce: at the amount the vault pays, one
    ///      base unit below it the withdrawal refuses. Then the balance pays when there is a
    ///      backup; with none the charge reports reason 3, moves nothing, and the same charge goes
    ///      through once the vault can pay.
    function testFuzz_liquidityIsTheVaultsToEnforce(
        uint96 amount,
        uint256 extra,
        uint256 yield,
        bool onTheLine,
        bool zeroMax,
        bool backup
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(backup);
        amount = uint96(bound(amount, 1, 1e15));
        _save(payer, amount + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));
        uint256 id = _openPeriodic(amount);
        vault.setLiquidity(onTheLine ? amount : amount - 1);
        bool fallsBack = _balanceCovers(amount);

        assertEq(_chargeAndCheck(id, amount), onTheLine || fallsBack, "charged when the vault or the backup can pay");
        if (!onTheLine && !fallsBack) {
            vault.setLiquidity(type(uint256).max);
            assertTrue(_chargeAndCheck(id, amount), "the same charge goes through once the vault can pay");
        }
    }

    /// @dev After yield a share is worth more than one base unit, so `previewWithdraw(amount)` is
    ///      below `amount`. With no backup, a share allowance of exactly that suffices and is spent
    ///      to zero; one share less is reason 2.
    function testFuzz_shareAllowanceIsTheExactPermissionLine(
        uint96 amount,
        uint256 extra,
        uint256 yield,
        uint256 shortBy,
        bool onTheLine,
        bool zeroMax
    ) public {
        vault.setZeroMax(zeroMax);
        amount = uint96(bound(amount, 1, 1e15));
        _save(payer, amount + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e16));
        uint256 id = _openPeriodic(amount);

        uint256 cost = vault.previewWithdraw(amount);
        _backup(false);
        vm.prank(payer);
        vault.approve(address(hub), onTheLine ? cost : cost - bound(shortBy, 1, cost));

        assertEq(_chargeAndCheck(id, amount), onTheLine, "charged exactly when the share allowance covers the cost");
        if (onTheLine) assertEq(vault.allowance(payer, address(hub)), 0, "the allowance spent is exactly the cost");
    }

    /// @dev With no backup and short of both shares and share allowance, the reason reported is
    ///      the shares: reason 1, as for a wallet short of both, whether or not the vault could
    ///      have paid.
    function testFuzz_shortOfBothReportsTheBalanceFirst(
        uint96 amount,
        uint256 extra,
        uint256 yield,
        uint256 shortBy,
        bool illiquid,
        bool zeroMax
    ) public {
        vault.setZeroMax(zeroMax);
        amount = uint96(bound(amount, 1, 1e15));
        uint256 id = _openPeriodic(amount);
        _save(payer, amount + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));
        uint256 cost = vault.previewWithdraw(amount);
        _keepShares(cost - 1);
        if (illiquid) vault.setLiquidity(amount - 1);
        _backup(false);
        vm.prank(payer);
        vault.approve(address(hub), cost - bound(shortBy, 1, cost));

        Position memory before = _position();
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, amount);
        hub.charge(id);
        _assertNothingMoved(before);
    }

    /*//////////////////////////////////////////////////////////////
                              PAYING SHORT
    //////////////////////////////////////////////////////////////*/

    /// @dev A funded charge from a vault that pays one base unit short never short-pays: the
    ///      receipt check undoes the withdrawal, and the balance pays in full, or with no backup
    ///      the charge reports reason 3 and moves and books nothing.
    function testFuzz_paysShortVaultNeverShortPaysOnCharge(
        uint96 amount,
        uint256 extra,
        uint256 yield,
        bool streaming,
        uint32 elapsed,
        bool zeroMax,
        bool backup
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(backup);
        amount = uint96(bound(amount, 1, 1e12));
        uint256 id = streaming ? _openStream(amount, type(uint96).max, type(uint96).max) : _openPeriodic(amount);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = streaming ? uint256(amount) * (block.timestamp - T0) : amount;
        _save(payer, due + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));

        vault.setPaysShort(true);
        Position memory before = _position();
        bool paid = _chargeARefusingVault(id, due);
        vault.setPaysShort(false);
        _assertRefusedChargeOutcome(before, paid, id, due);
    }

    /// @dev The settlement inside a pause or a cancel, by any party allowed to make it, against a
    ///      vault that pays short: the balance pays the accrual, or with no backup it is reported
    ///      as reason 3, nothing moves or is booked, and the stop goes ahead either way.
    function testFuzz_paysShortSettlementReportsReasonThreeAndMovesNothing(
        uint96 rate,
        uint32 elapsed,
        uint256 extra,
        uint256 yield,
        uint256 how,
        bool zeroMax,
        bool backup
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(backup);
        rate = uint96(bound(rate, 1, 1e9));
        uint256 id = _openStream(rate, type(uint96).max, type(uint96).max);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = uint256(rate) * (block.timestamp - T0);
        _save(payer, due + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));

        vault.setPaysShort(true);
        _settleWhenTheVaultCannotPay(id, how, REASON_TRANSFER_REFUSED, due);
    }

    /// @dev The receipt check is for exactly the amount, not at least it: a vault paying one
    ///      base unit over is refused on a charge, its withdrawal undone, and the balance pays or
    ///      the charge reports reason 3.
    function testFuzz_overpayingVaultIsRefusedOnCharge(
        uint96 amount,
        uint256 extra,
        uint256 others,
        bool streaming,
        uint32 elapsed,
        bool zeroMax,
        bool backup
    ) public {
        _swapIn(new OverpayingVault(usd), zeroMax);
        _backup(backup);
        amount = uint96(bound(amount, 1, 1e12));
        uint256 id = streaming ? _openStream(amount, type(uint96).max, type(uint96).max) : _openPeriodic(amount);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = streaming ? uint256(amount) * (block.timestamp - T0) : amount;
        _save(payer, due + bound(extra, 0, 1e16));
        _save(saver, bound(others, 1, 1e16));

        Position memory before = _position();
        bool paid = _chargeARefusingVault(id, due);
        if (paid) _assertPaidFromBalance(before, due);
        else _assertNothingMoved(before);
    }

    /// @dev The same vault, inside a pause or cancel: the balance settles, or reason 3.
    function testFuzz_overpayingVaultSettlementReportsReasonThreeAndMovesNothing(
        uint96 rate,
        uint32 elapsed,
        uint256 extra,
        uint256 others,
        uint256 how,
        bool zeroMax,
        bool backup
    ) public {
        _swapIn(new OverpayingVault(usd), zeroMax);
        _backup(backup);
        rate = uint96(bound(rate, 1, 1e9));
        uint256 id = _openStream(rate, type(uint96).max, type(uint96).max);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = uint256(rate) * (block.timestamp - T0);
        _save(payer, due + bound(extra, 0, 1e16));
        _save(saver, bound(others, 1, 1e16));

        _settleWhenTheVaultCannotPay(id, how, REASON_TRANSFER_REFUSED, due);
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev A pause or cancel with the vault able to pay settles exactly the accrual from it.
    function testFuzz_settlementFromAVaultTakesExactlyTheAccrual(
        uint96 rate,
        uint96 maxPerCharge,
        uint32 elapsed,
        uint256 extra,
        uint256 yield,
        uint256 how,
        bool zeroMax
    ) public {
        vault.setZeroMax(zeroMax);
        rate = uint96(bound(rate, 1, 1e9));
        maxPerCharge = uint96(bound(maxPerCharge, 1, 1e15));
        uint256 id = _openStream(rate, maxPerCharge, type(uint96).max);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = _min(uint256(rate) * (block.timestamp - T0), maxPerCharge);
        _save(payer, due + bound(extra, 0, 1e16));
        _yield(bound(yield, 0, 1e15));

        Position memory before = _position();
        uint256 cost = vault.previewWithdraw(due);
        (address by, bool cancelling) = _stopper(how);
        vm.prank(by);
        if (cancelling) hub.cancelMandate(id);
        else hub.pauseMandate(id);

        _assertMovedExactly(before, due, cost);
        IMandateHub.Mandate memory m = hub.getMandate(id);
        assertEq(m.totalCharged, due, "the settlement books exactly what moved");
        assertEq(m.nextChargeAt, block.timestamp, "the checkpoint moves to the settlement");
    }

    /// @dev A pause or cancel whose settlement the savings cannot fund, short of shares or of
    ///      share allowance, or short of liquidity, which is a refused withdrawal: the balance
    ///      settles it, or with no backup the vault's reason is reported. The stream stops either way.
    function testFuzz_settlementShortfallFromAVaultReportsWhyAndMovesNothing(
        uint96 rate,
        uint32 elapsed,
        uint256 yield,
        uint256 why,
        uint256 how,
        bool zeroMax,
        bool backup
    ) public {
        vault.setZeroMax(zeroMax);
        _backup(backup);
        rate = uint96(bound(rate, 1, 1e9));
        uint256 id = _openStream(rate, type(uint96).max, type(uint96).max);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = uint256(rate) * (block.timestamp - T0);
        _save(payer, due);
        _yield(bound(yield, 0, 1e15));
        uint256 cost = vault.previewWithdraw(due);

        uint8 reason;
        why = why % 3;
        if (why == 0) {
            _keepShares(cost - 1);
            reason = REASON_INSUFFICIENT_BALANCE;
        } else if (why == 1) {
            vm.prank(payer);
            vault.approve(address(hub), cost - 1);
            reason = REASON_INSUFFICIENT_ALLOWANCE;
        } else {
            vault.setLiquidity(due - 1);
            reason = REASON_TRANSFER_REFUSED;
        }

        _settleWhenTheVaultCannotPay(id, how, reason, due);
    }

    function testFuzz_settlementPullIsForTheHubAlone(address caller, uint256 amount, uint32 elapsed) public {
        if (caller == address(hub) || caller == address(vm) || caller == CONSOLE) caller = stranger;
        uint256 id = _openStream(100, type(uint96).max, type(uint96).max);
        _save(payer, 1_000 * uint256(DOLLAR));
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        Position memory before = _position();
        bytes memory record = abi.encode(hub.getMandate(id));

        vm.prank(caller);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.pullForSettlement(id, bound(amount, 0, 1_000 * uint256(DOLLAR)));

        vm.prank(caller);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.pullFromVault(id, bound(amount, 0, 1_000 * uint256(DOLLAR)));

        _assertNothingMoved(before);
        assertEq(abi.encode(hub.getMandate(id)), record, "the refused pull changed the record");
    }

    /*//////////////////////////////////////////////////////////////
                          A VAULT THAT CANNOT ANSWER
    //////////////////////////////////////////////////////////////*/

    /// @dev A vault that stops answering `previewWithdraw` or the share `balanceOf`, by reverting
    ///      or by returning nothing a typed call can decode, as a vault paused behind a proxy or
    ///      mid-migration can: the balance pays, or with no backup the charge reports reason 3,
    ///      moves and books nothing, and goes through once the vault answers again.
    function testFuzz_aVaultThatCannotQuoteFallsBackOrFailsCleanly(
        uint96 amount,
        uint256 extra,
        uint256 fault,
        bool streaming,
        uint32 elapsed,
        bool zeroMax,
        bool backup
    ) public {
        MisquotingVault misquoting = new MisquotingVault(usd);
        _swapIn(misquoting, zeroMax);
        _backup(backup);
        amount = uint96(bound(amount, 1, 1e12));
        uint256 id = streaming ? _openStream(amount, type(uint96).max, type(uint96).max) : _openPeriodic(amount);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = streaming ? uint256(amount) * (block.timestamp - T0) : amount;
        _save(payer, due + bound(extra, 0, 1e16));

        Position memory before = _position();
        _misquote(misquoting, fault);
        bool paid = _chargeARefusingVault(id, due);
        misquoting.setFaults(MisquotingVault.Fault.None, MisquotingVault.Fault.None);
        _assertRefusedChargeOutcome(before, paid, id, due);
    }

    /// @dev `_settle` never fails on the payer's account: the vault's funding check and pull run
    ///      together inside the `pullFromVault` self-call, so a vault that cannot answer is caught
    ///      with the rest. The balance settles the accrual, or with no backup it is reported as
    ///      reason 3 with nothing moved or booked, and the pause or cancel goes ahead for the
    ///      payer, the manager and the merchant alike.
    function testFuzz_stopGoesAheadWhenTheVaultCannotQuote(
        uint96 rate,
        uint32 elapsed,
        uint256 extra,
        uint256 fault,
        uint256 how,
        bool zeroMax,
        bool backup
    ) public {
        MisquotingVault misquoting = new MisquotingVault(usd);
        _swapIn(misquoting, zeroMax);
        _backup(backup);
        rate = uint96(bound(rate, 1, 1e9));
        uint256 id = _openStream(rate, type(uint96).max, type(uint96).max);
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        uint256 due = uint256(rate) * (block.timestamp - T0);
        _save(payer, due + bound(extra, 0, 1e16));

        Position memory before = _position();
        IMandateHub.Mandate memory m = hub.getMandate(id);
        (address by, bool cancelling) = _stopper(how);
        bool fallsBack = _balanceCovers(due);
        _misquote(misquoting, fault);

        vm.expectEmit(address(hub));
        if (fallsBack) emit IMandateHub.ChargedFromBalance(id, due);
        else emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, due);
        vm.prank(by);
        if (cancelling) hub.cancelMandate(id);
        else hub.pauseMandate(id);

        misquoting.setFaults(MisquotingVault.Fault.None, MisquotingVault.Fault.None);
        if (fallsBack) _assertPaidFromBalance(before, due);
        else _assertNothingMoved(before);
        IMandateHub.Mandate memory stopped = hub.getMandate(id);
        assertEq(stopped.totalCharged, m.totalCharged + (fallsBack ? due : 0), "booked exactly what moved");
        if (cancelling) assertEq(uint8(stopped.status), uint8(IMandateHub.Status.Cancelled), "the cancel went ahead");
        else assertEq(stopped.pausedAt, block.timestamp, "the pause went ahead");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Charge `id`, which must be due for `due`, and check the outcome against the answers
    ///      of the vault and the asset taken just before: exactly `due` moved from the vault
    ///      position to the merchant when the vault can pay; otherwise exactly `due` from the
    ///      payer's balance when that can pay; otherwise a failure for `due` with the vault's
    ///      reason and nothing moved. Returns whether the charge went through.
    function _chargeAndCheck(uint256 id, uint256 due) internal returns (bool charged) {
        uint8 reason = _vaultReason(due);
        if (reason != 0) return _chargeWhenTheVaultCannotPay(id, due, reason);

        Position memory before = _position();
        IMandateHub.Mandate memory m = hub.getMandate(id);
        uint256 cost = vault.previewWithdraw(due);

        hub.charge(id);
        _assertMovedExactly(before, due, cost);
        IMandateHub.Mandate memory afterward = hub.getMandate(id);
        assertEq(afterward.totalCharged, m.totalCharged + due, "the charge books exactly what moved");
        assertEq(uint8(afterward.status), uint8(IMandateHub.Status.Active), "a successful charge is active");
        return true;
    }

    /// @dev Why the vault cannot pay `due` now, judged from its own answers, or zero when it can:
    ///      shares below its price for it (1), share allowance below it (2), or liquidity below
    ///      the amount, which makes the withdrawal refuse (3).
    function _vaultReason(uint256 due) internal view returns (uint8) {
        uint256 cost = vault.previewWithdraw(due);
        if (vault.balanceOf(payer) < cost) return REASON_INSUFFICIENT_BALANCE;
        if (vault.allowance(payer, address(hub)) < cost) return REASON_INSUFFICIENT_ALLOWANCE;
        if (vault.liquidity() < due) return REASON_TRANSFER_REFUSED;
        return 0;
    }

    /// @dev Charge `id` for `due` against a vault that cannot pay it for `reason`: the balance
    ///      pays exactly `due` when it can, announced by `ChargedFromBalance`, and otherwise the
    ///      charge reports `reason`, moves nothing and leaves the schedule. Returns whether it paid.
    function _chargeWhenTheVaultCannotPay(uint256 id, uint256 due, uint8 reason) internal returns (bool paid) {
        Position memory before = _position();
        IMandateHub.Mandate memory m = hub.getMandate(id);
        paid = _balanceCovers(due);

        vm.expectEmit(address(hub));
        if (paid) emit IMandateHub.ChargedFromBalance(id, due);
        else emit IMandateHub.ChargeFailed(id, reason, due);
        hub.charge(id);

        IMandateHub.Mandate memory afterward = hub.getMandate(id);
        if (paid) {
            _assertPaidFromBalance(before, due);
            assertEq(afterward.totalCharged, m.totalCharged + due, "the charge books exactly what moved");
            assertEq(uint8(afterward.status), uint8(IMandateHub.Status.Active), "a successful charge is active");
        } else {
            _assertNothingMoved(before);
            assertEq(afterward.nextChargeAt, m.nextChargeAt, "a failed charge leaves the schedule");
            assertEq(afterward.totalCharged, m.totalCharged, "a failed charge books nothing");
            assertEq(uint8(afterward.status), uint8(IMandateHub.Status.Delinquent), "a failed charge is delinquent");
        }
    }

    /// @dev Charge `id` for `due` against a vault that refuses however well funded the payer is:
    ///      paying short or over, or unable to answer. Reason 3 unless the balance pays. Reads
    ///      nothing from the vault, which may not answer, so the caller checks the outcome.
    function _chargeARefusingVault(uint256 id, uint256 due) internal returns (bool paid) {
        paid = _balanceCovers(due);
        vm.expectEmit(address(hub));
        if (paid) emit IMandateHub.ChargedFromBalance(id, due);
        else emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, due);
        hub.charge(id);
    }

    /// @dev After a refusing vault was mended: the balance paid exactly `due`, booked it, and left
    ///      the vault alone; or nothing moved or was booked, and the same charge now goes through
    ///      from the vault.
    function _assertRefusedChargeOutcome(Position memory before, bool paid, uint256 id, uint256 due) internal {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (paid) {
            _assertPaidFromBalance(before, due);
            assertEq(m.totalCharged, due, "the fallback books exactly what moved");
            assertEq(uint8(m.status), uint8(IMandateHub.Status.Active), "a paid charge is active");
        } else {
            _assertNothingMoved(before);
            assertEq(m.totalCharged, 0, "a failed charge books nothing");
            assertEq(uint8(m.status), uint8(IMandateHub.Status.Delinquent), "a failed charge is delinquent");
            assertTrue(_chargeAndCheck(id, due), "the same charge goes through once the vault pays");
        }
    }

    /// @dev Pause or cancel `id` against a vault that cannot pay the accrual `due` for `reason`:
    ///      the balance settles exactly `due` when it can, otherwise `reason` is reported with
    ///      nothing moved or booked. The stop goes ahead either way.
    function _settleWhenTheVaultCannotPay(uint256 id, uint256 how, uint8 reason, uint256 due) internal {
        Position memory before = _position();
        IMandateHub.Mandate memory m = hub.getMandate(id);
        (address by, bool cancelling) = _stopper(how);
        bool paid = _balanceCovers(due);

        vm.expectEmit(address(hub));
        if (paid) emit IMandateHub.ChargedFromBalance(id, due);
        else emit IMandateHub.ChargeFailed(id, reason, due);
        vm.prank(by);
        if (cancelling) hub.cancelMandate(id);
        else hub.pauseMandate(id);

        IMandateHub.Mandate memory stopped = hub.getMandate(id);
        if (paid) {
            _assertPaidFromBalance(before, due);
            assertEq(stopped.totalCharged, m.totalCharged + due, "the settlement books exactly what moved");
            assertEq(stopped.nextChargeAt, block.timestamp, "the checkpoint moves to the settlement");
        } else {
            _assertNothingMoved(before);
            assertEq(stopped.totalCharged, m.totalCharged, "the failed settlement booked nothing");
            assertEq(stopped.nextChargeAt, m.nextChargeAt, "the failed settlement left the checkpoint");
        }
        if (cancelling) {
            assertEq(uint8(stopped.status), uint8(IMandateHub.Status.Cancelled), "the cancel went ahead");
        } else {
            assertEq(stopped.pausedAt, block.timestamp, "the pause went ahead");
            assertEq(
                uint8(stopped.status),
                uint8(paid ? IMandateHub.Status.Active : IMandateHub.Status.Delinquent),
                "a paused stream is delinquent exactly when its settlement failed"
            );
        }
    }

    /// @dev Whether the payer's balance of the asset, the fallback, can pay `due` now.
    function _balanceCovers(uint256 due) internal view returns (bool) {
        return usd.balanceOf(payer) >= due && usd.allowance(payer, address(hub)) >= due;
    }

    /// @dev The backup a savings mandate falls back to: an unlimited allowance on the asset, or none.
    function _backup(bool on) internal {
        vm.prank(payer);
        usd.approve(address(hub), on ? type(uint256).max : 0);
    }

    /// @dev Pause by the payer or the manager, or cancel by the payer, the merchant or the manager.
    function _stopper(uint256 how) internal view returns (address by, bool cancelling) {
        uint256 k = how % 5;
        if (k < 2) return (k == 0 ? payer : manager, false);
        return ([payer, merchant, manager][k - 2], true);
    }

    /// @dev Draw from `replacement` instead, in the given `max*` mode, with the payer's unlimited
    ///      share allowance to the hub.
    function _swapIn(MockVault replacement, bool zeroMax) internal {
        vault = replacement;
        vault.setZeroMax(zeroMax);
        vm.prank(payer);
        vault.approve(address(hub), type(uint256).max);
    }

    /// @dev Switch `misquoting` to one of its four faults, `previewWithdraw` or `balanceOf`
    ///      reverting or answering nothing, and return what a charge against it reverts with.
    function _misquote(MisquotingVault misquoting, uint256 seed) internal returns (bytes memory revertData) {
        MisquotingVault.Fault fault =
            seed % 2 == 0 ? MisquotingVault.Fault.Reverts : MisquotingVault.Fault.AnswersNothing;
        if ((seed >> 1) % 2 == 0) misquoting.setFaults(fault, MisquotingVault.Fault.None);
        else misquoting.setFaults(MisquotingVault.Fault.None, fault);
        return fault == MisquotingVault.Fault.Reverts
            ? abi.encodeWithSignature("Error(string)", "MisquotingVault: no quote")
            : bytes("");
    }

    /// @dev A periodic mandate on `usd` drawn from the vault, with room for every charge here.
    function _openPeriodic(uint96 amount) internal returns (uint256) {
        IMandateHub.Terms memory t = monthly();
        t.vault = address(vault);
        t.amount = amount;
        t.maxPerCharge = amount;
        t.maxTotal = type(uint96).max;
        t.expiresAt = FAR;
        return create(t);
    }

    /// @dev A stream on `usd` drawn from the vault, accruing from now.
    function _openStream(uint96 rate, uint96 maxPerCharge, uint96 maxTotal) internal returns (uint256) {
        IMandateHub.Terms memory t = perSecond();
        t.vault = address(vault);
        t.amount = rate;
        t.maxPerCharge = maxPerCharge;
        t.maxTotal = maxTotal;
        t.expiresAt = FAR;
        return create(t);
    }

    /// @dev `who` deposits `assets` into the vault, minted to it first, leaving its wallet as it was.
    function _save(address who, uint256 assets) internal {
        deal(address(usd), who, usd.balanceOf(who) + assets);
        vm.startPrank(who);
        usd.approve(address(vault), assets);
        vault.deposit(assets, who);
        vm.stopPrank();
    }

    /// @dev The payer keeps exactly `shares` and hands the rest to the other depositor, which
    ///      moves no asset and no share price. The payer must hold at least `shares`.
    function _keepShares(uint256 shares) internal {
        uint256 held = vault.balanceOf(payer);
        vm.prank(payer);
        assertTrue(vault.transfer(saver, held - shares), "share transfer");
    }

    /// @dev Yield: the asset lands in the vault without new shares, raising every share's worth.
    function _yield(uint256 assets) internal {
        deal(address(usd), address(vault), usd.balanceOf(address(vault)) + assets);
    }

    /// @dev No cap one time in three, otherwise a cap anywhere from zero to twice `around`.
    function _capLiquidity(uint256 seed, uint256 around) internal {
        vault.setLiquidity(seed % 3 == 0 ? type(uint256).max : bound(seed >> 2, 0, 2 * around));
    }

    function _position() internal view returns (Position memory p) {
        p.merchantAssets = usd.balanceOf(merchant);
        p.vaultAssets = usd.balanceOf(address(vault));
        p.payerShares = vault.balanceOf(payer);
        p.saverShares = vault.balanceOf(saver);
        p.shareSupply = vault.totalSupply();
        p.payerWallet = usd.balanceOf(payer);
        p.payerWalletAllowance = usd.allowance(payer, address(hub));
        p.hubAssets = usd.balanceOf(address(hub));
        p.hubShares = vault.balanceOf(address(hub));
    }

    function _assertMovedExactly(Position memory b, uint256 amount, uint256 cost) internal view {
        Position memory a = _position();
        assertEq(a.merchantAssets, b.merchantAssets + amount, "the merchant receives exactly the amount");
        assertEq(b.vaultAssets - a.vaultAssets, amount, "the vault pays out exactly the amount");
        assertEq(b.payerShares - a.payerShares, cost, "the payer's shares fall by exactly previewWithdraw(amount)");
        assertEq(b.shareSupply - a.shareSupply, cost, "exactly those shares are burned");
        assertEq(a.saverShares, b.saverShares, "no other depositor is touched");
        assertEq(a.payerWallet, b.payerWallet, "the payer's wallet is untouched");
        assertEq(a.payerWalletAllowance, b.payerWalletAllowance, "the payer's asset allowance is untouched");
        assertEq(a.hubAssets, 0, "the hub holds no asset");
        assertEq(a.hubShares, 0, "the hub holds no shares");
    }

    /// @dev Exactly `amount` went from the payer's wallet to the merchant, spending the allowance
    ///      unless it is unlimited, and the vault and every share were left alone.
    function _assertPaidFromBalance(Position memory b, uint256 amount) internal view {
        Position memory a = _position();
        assertEq(a.merchantAssets, b.merchantAssets + amount, "the merchant receives exactly the amount");
        assertEq(b.payerWallet - a.payerWallet, amount, "the wallet pays exactly the amount");
        uint256 allowance =
            b.payerWalletAllowance == type(uint256).max ? b.payerWalletAllowance : b.payerWalletAllowance - amount;
        assertEq(a.payerWalletAllowance, allowance, "the asset allowance spent is exactly the amount");
        assertEq(a.vaultAssets, b.vaultAssets, "the vault pays nothing");
        assertEq(a.payerShares, b.payerShares, "the payer's shares are untouched");
        assertEq(a.saverShares, b.saverShares, "no other depositor is touched");
        assertEq(a.shareSupply, b.shareSupply, "no share is burned");
        assertEq(a.hubAssets, 0, "the hub holds no asset");
        assertEq(a.hubShares, 0, "the hub holds no shares");
    }

    function _assertNothingMoved(Position memory b) internal view {
        assertEq(abi.encode(_position()), abi.encode(b), "nothing may move");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
