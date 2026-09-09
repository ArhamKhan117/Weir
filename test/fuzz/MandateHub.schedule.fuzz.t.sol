// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {HubFixture} from "../helpers/HubFixture.sol";
import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE
} from "../../src/interfaces/IMandateHub.sol";

/// @title MandateHubScheduleFuzzTest
/// @notice The periodic schedule is a fixed lattice `anchor + k * period`, where the anchor is the
///         `nextChargeAt` recorded at creation. After a charge at time `t` the next boundary is the
///         first lattice point strictly after `t`: later than `t`, at most one period away, and on
///         the lattice. Missed periods are skipped rather than owed, a failed charge does not move
///         the schedule, and two successful charges can never land in the same period.
contract MandateHubScheduleFuzzTest is HubFixture {
    uint32 internal constant MIN_PERIOD = 60;
    uint32 internal constant MAX_PERIOD = 31_536_000;

    /// @dev Far enough out that no sequence here reaches expiry.
    uint64 internal constant FAR = T0 + 200 * 365 days;

    function setUp() public override {
        super.setUp();
        deal(address(usd), payer, type(uint128).max);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
    }

    function testFuzz_chargeAdvancesToFirstBoundaryAfterNow(
        uint96 amount,
        uint32 period,
        uint64 anchorSeed,
        uint64 lateness
    ) public {
        amount = uint96(bound(amount, 1, 1e12));
        period = _boundPeriod(period);
        uint64 anchor = _boundAnchor(anchorSeed);
        uint256 id = _open(amount, period, anchor);

        uint256 t = _firstDue(anchor) + bound(lateness, 0, 100 * 365 days);
        vm.warp(t);
        hub.charge(id);

        _assertOnLattice(hub.getMandate(id).nextChargeAt, t, anchor, period);
        assertEq(usd.balanceOf(merchant), amount, "exactly one amount moved");
        assertEq(hub.getMandate(id).totalCharged, amount, "exactly one amount booked");
    }

    function testFuzz_chargesNeverShareAPeriod(uint32 period, uint64 anchorSeed, uint32[10] memory gaps) public {
        period = _boundPeriod(period);
        uint64 anchor = _boundAnchor(anchorSeed);
        uint256 id = _open(DOLLAR, period, anchor);
        vm.warp(_firstDue(anchor));

        bool charged;
        uint256 lastIndex;
        uint256 charges;
        for (uint256 i = 0; i < gaps.length; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 3 * uint256(period)));
            uint256 index = (block.timestamp - anchor) / period;
            uint64 due = hub.getMandate(id).nextChargeAt;

            if (block.timestamp < due) {
                // Refused only while still inside the period of the last charge.
                assertTrue(charged, "the first boundary is always due");
                assertEq(index, lastIndex, "refused only within the charged period");
                vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, due, block.timestamp));
                hub.charge(id);
                continue;
            }

            hub.charge(id);
            if (charged) assertGt(index, lastIndex, "two charges in one period");
            _assertOnLattice(hub.getMandate(id).nextChargeAt, block.timestamp, anchor, period);
            charged = true;
            lastIndex = index;
            ++charges;
        }

        assertEq(hub.getMandate(id).totalCharged, charges * DOLLAR, "one amount per charge");
    }

    function testFuzz_secondChargeInSamePeriodRevertsNotDue(
        uint32 period,
        uint64 anchorSeed,
        uint64 lateness,
        uint64 wait
    ) public {
        period = _boundPeriod(period);
        uint64 anchor = _boundAnchor(anchorSeed);
        uint256 id = _open(DOLLAR, period, anchor);

        uint256 t = _firstDue(anchor) + bound(lateness, 0, 50 * 365 days);
        vm.warp(t);
        hub.charge(id);
        uint64 next = hub.getMandate(id).nextChargeAt;

        vm.warp(t + bound(wait, 0, next - t - 1));
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, next, block.timestamp));
        hub.charge(id);

        assertEq(hub.getMandate(id).totalCharged, DOLLAR, "the refused charge booked nothing");
    }

    function testFuzz_missedPeriodsAreSkippedNotOwed(uint96 amount, uint32 period, uint256 missed, uint32 into) public {
        amount = uint96(bound(amount, 1, 1e12));
        period = _boundPeriod(period);
        missed = bound(missed, 0, 100);
        uint256 id = _open(amount, period, 0);

        uint256 t = T0 + missed * period + bound(into, 0, period - 1);
        vm.warp(t);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), amount, "one amount, however many periods were missed");
        assertEq(hub.getMandate(id).totalCharged, amount, "nothing owed for missed periods");
        assertEq(hub.getMandate(id).nextChargeAt, T0 + (missed + 1) * period, "the boundary after now");

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0 + (missed + 1) * period, t));
        hub.charge(id);
    }

    function testFuzz_failedChargeLeavesScheduleUntouched(
        uint32 period,
        uint64 anchorSeed,
        uint64 lateness,
        bool allowanceShort
    ) public {
        period = _boundPeriod(period);
        uint64 anchor = _boundAnchor(anchorSeed);
        uint256 id = _open(DOLLAR, period, anchor);
        uint256 t = _firstDue(anchor) + bound(lateness, 0, 50 * 365 days);
        vm.warp(t);
        IMandateHub.Mandate memory before = hub.getMandate(id);

        _starve(allowanceShort);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(
            id, allowanceShort ? REASON_INSUFFICIENT_ALLOWANCE : REASON_INSUFFICIENT_BALANCE, DOLLAR
        );
        hub.charge(id);

        IMandateHub.Mandate memory failed = hub.getMandate(id);
        assertEq(failed.nextChargeAt, before.nextChargeAt, "schedule untouched");
        assertEq(failed.totalCharged, 0, "nothing booked");
        assertEq(uint8(failed.status), uint8(IMandateHub.Status.Delinquent), "delinquent");
        assertEq(usd.balanceOf(merchant), 0, "nothing moved");

        // Funded again in the same instant, the retry lands exactly where a first try would have.
        deal(address(usd), payer, type(uint128).max);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
        hub.charge(id);

        _assertOnLattice(hub.getMandate(id).nextChargeAt, t, anchor, period);
        assertEq(uint8(hub.getMandate(id).status), uint8(IMandateHub.Status.Active), "active again");
        assertEq(usd.balanceOf(merchant), DOLLAR, "one amount moved");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A periodic mandate on `usd` with an unbounded lifetime cap and a distant expiry.
    ///      `anchor` zero means the creation block.
    function _open(uint96 amount, uint32 period, uint64 anchor) internal returns (uint256) {
        IMandateHub.Terms memory t = monthly();
        t.amount = amount;
        t.period = period;
        t.startAt = anchor;
        t.maxPerCharge = amount;
        t.maxTotal = type(uint96).max;
        t.expiresAt = FAR;
        return create(t);
    }

    function _boundPeriod(uint32 period) internal pure returns (uint32) {
        return uint32(bound(period, MIN_PERIOD, MAX_PERIOD));
    }

    /// @dev Any explicit anchor from the first second to ten years out: a past anchor is kept as
    ///      given, so the lattice can start long before the mandate existed.
    function _boundAnchor(uint64 seed) internal pure returns (uint64) {
        return uint64(bound(seed, 1, T0 + 10 * 365 days));
    }

    /// @dev The first moment the mandate is due: its anchor, or now when the anchor is past.
    function _firstDue(uint64 anchor) internal view returns (uint256) {
        return anchor > block.timestamp ? anchor : block.timestamp;
    }

    function _starve(bool allowanceShort) internal {
        if (allowanceShort) {
            vm.prank(payer);
            usd.approve(address(hub), 0);
        } else {
            deal(address(usd), payer, 0);
        }
    }

    function _assertOnLattice(uint64 next, uint256 t, uint64 anchor, uint32 period) internal pure {
        assertGt(next, t, "the next boundary is after the charge");
        assertLe(next - t, period, "the next boundary is at most one period away");
        assertEq((next - uint256(anchor)) % period, 0, "the next boundary is on the anchor's lattice");
        assertEq(
            (next - uint256(anchor)) / period,
            (t - uint256(anchor)) / period + 1,
            "the next boundary is the first lattice point after the charge"
        );
    }
}
