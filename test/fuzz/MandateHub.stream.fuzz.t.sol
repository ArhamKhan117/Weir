// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {HubFixture} from "../helpers/HubFixture.sol";
import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE
} from "../../src/interfaces/IMandateHub.sol";

/// @title MandateHubStreamFuzzTest
/// @notice Streaming accrual never overbills. For arbitrary rates, caps, and sequences of warps,
///         charges, pauses and resumes, every charge is at most `maxPerCharge` and at most the rate
///         times the seconds since the checkpoint; the running total stays within `maxTotal` and
///         within the rate times the seconds the stream actually ran; paused time is never billed;
///         nothing accrues before creation; and accrual above the per-charge cap is forfeited
///         rather than carried.
contract MandateHubStreamFuzzTest is HubFixture {
    /// @dev Far enough out that no sequence here reaches expiry.
    uint64 internal constant FAR = T0 + 100 * 365 days;

    /// @dev A reference model of one stream, kept independently of the hub.
    struct Model {
        uint256 checkpoint;
        uint256 pausedAt;
        uint256 running;
        uint256 total;
    }

    /// @dev The stream under test and its fixed terms.
    struct Stream {
        uint256 id;
        uint256 rate;
        uint256 maxPerCharge;
        uint256 maxTotal;
    }

    function setUp() public override {
        super.setUp();
        deal(address(usd), payer, type(uint128).max);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                              SINGLE CHARGES
    //////////////////////////////////////////////////////////////*/

    function testFuzz_chargeTakesMinOfAccrualAndCaps(uint96 rate, uint96 maxPerCharge, uint96 maxTotal, uint64 elapsed)
        public
    {
        rate = uint96(bound(rate, 1, type(uint96).max));
        maxPerCharge = uint96(bound(maxPerCharge, 1, type(uint96).max));
        maxTotal = uint96(bound(maxTotal, 1, type(uint96).max));
        elapsed = uint64(bound(elapsed, 1, 50 * 365 days));
        uint256 id = _open(rate, maxPerCharge, maxTotal, 0);

        vm.warp(T0 + elapsed);
        hub.charge(id);

        uint256 expected = _min3(uint256(rate) * elapsed, maxPerCharge, maxTotal);
        assertEq(usd.balanceOf(merchant), expected, "min of accrual, per-charge cap and lifetime cap");
        assertEq(hub.getMandate(id).totalCharged, expected, "booked what moved");
        assertEq(hub.getMandate(id).nextChargeAt, block.timestamp, "checkpoint moves to now");
    }

    function testFuzz_accrualAboveCapIsForfeited(uint96 rate, uint96 maxPerCharge, uint32 first, uint32 second) public {
        rate = uint96(bound(rate, 1, 1e12));
        maxPerCharge = uint96(bound(maxPerCharge, 1, type(uint96).max));
        uint256 a = bound(first, 1, 365 days);
        uint256 b = bound(second, 1, 365 days);
        uint256 id = _open(rate, maxPerCharge, type(uint96).max, 0);

        vm.warp(T0 + a);
        hub.charge(id);
        uint256 firstCharge = usd.balanceOf(merchant);
        assertEq(firstCharge, _min2(rate * a, maxPerCharge), "first charge capped");

        vm.warp(T0 + a + b);
        hub.charge(id);
        assertEq(
            usd.balanceOf(merchant) - firstCharge,
            _min2(rate * b, maxPerCharge),
            "the second charge accrues from the first, carrying nothing forfeited"
        );
    }

    function testFuzz_pastStartNeverBillsBeforeCreation(uint96 rate, uint64 backdate, uint32 elapsed) public {
        rate = uint96(bound(rate, 1, type(uint96).max));
        uint64 startAt = uint64(T0 - bound(backdate, 1, T0 - 1));
        uint256 e = bound(elapsed, 1, 365 days);
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, startAt);

        assertEq(hub.getMandate(id).nextChargeAt, T0, "a past start is lifted to the creation block");
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0, T0));
        hub.charge(id);

        vm.warp(T0 + e);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), _min2(uint256(rate) * e, type(uint96).max), "only time since creation");
    }

    function testFuzz_futureStartAccruesOnlyFromStart(uint96 rate, uint32 lead, uint32 early, uint32 elapsed) public {
        rate = uint96(bound(rate, 1, 1e12));
        uint256 start = T0 + bound(lead, 1, 365 days);
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, uint64(start));

        vm.warp(T0 + bound(early, 0, start - T0));
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, start, block.timestamp));
        hub.charge(id);

        uint256 e = bound(elapsed, 1, 365 days);
        vm.warp(start + e);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), rate * e, "only time since the start");
    }

    /*//////////////////////////////////////////////////////////////
                              PAUSE AND RESUME
    //////////////////////////////////////////////////////////////*/

    function testFuzz_pausedTimeIsNeverBilled(uint96 rate, uint32 runBefore, uint32 pausedFor, uint32 runAfter) public {
        rate = uint96(bound(rate, 1, 1e12));
        uint256 a = bound(runBefore, 0, 365 days);
        uint256 b = bound(pausedFor, 0, 365 days);
        uint256 c = bound(runAfter, 1, 365 days);
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, 0);

        vm.warp(T0 + a);
        vm.prank(payer);
        hub.pauseMandate(id);
        assertEq(usd.balanceOf(merchant), rate * a, "pause settles the time run so far");

        vm.warp(T0 + a + b);
        vm.prank(payer);
        hub.resumeMandate(id);
        assertEq(hub.getMandate(id).nextChargeAt, block.timestamp, "the paused interval is skipped");

        vm.warp(T0 + a + b + c);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), rate * (a + c), "billed for running time only");
    }

    function testFuzz_pausedStreamCannotBeCharged(uint96 rate, uint32 runBefore, uint32 pausedFor) public {
        rate = uint96(bound(rate, 1, 1e12));
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, 0);

        vm.warp(T0 + bound(runBefore, 0, 365 days));
        vm.prank(manager);
        hub.pauseMandate(id);
        uint256 settled = usd.balanceOf(merchant);

        vm.warp(block.timestamp + bound(pausedFor, 0, 365 days));
        assertFalse(hub.isChargeable(id), "not chargeable while paused");
        assertEq(hub.quoteCharge(id), 0, "nothing quoted while paused");
        vm.expectRevert(IMandateHub.MandateIsPaused.selector);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), settled, "nothing moved while paused");
    }

    function testFuzz_unsettledAccrualSurvivesPause(
        uint96 rate,
        uint32 runBefore,
        uint32 pausedFor,
        uint32 runAfter,
        bool allowanceShort
    ) public {
        rate = uint96(bound(rate, 1, 1e12));
        uint256 a = bound(runBefore, 1, 365 days);
        uint256 b = bound(pausedFor, 0, 365 days);
        uint256 c = bound(runAfter, 0, 365 days);
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, 0);

        _starve(allowanceShort);
        vm.warp(T0 + a);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(
            id, allowanceShort ? REASON_INSUFFICIENT_ALLOWANCE : REASON_INSUFFICIENT_BALANCE, rate * a
        );
        vm.prank(payer);
        hub.pauseMandate(id);

        IMandateHub.Mandate memory paused = hub.getMandate(id);
        assertEq(paused.pausedAt, block.timestamp, "the pause went ahead");
        assertEq(paused.nextChargeAt, T0, "the checkpoint stays where it was");
        assertEq(paused.totalCharged, 0, "nothing booked");
        assertEq(uint8(paused.status), uint8(IMandateHub.Status.Delinquent), "delinquent");

        _refund();
        vm.warp(T0 + a + b);
        vm.prank(payer);
        hub.resumeMandate(id);
        vm.warp(T0 + a + b + c);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), rate * (a + c), "the unsettled run stays owed, the pause does not");
        assertEq(uint8(hub.getMandate(id).status), uint8(IMandateHub.Status.Active), "active again");
    }

    function testFuzz_cancelSettlesAccruedBestEffort(
        uint96 rate,
        uint96 maxPerCharge,
        uint32 elapsed,
        uint256 role,
        bool funded
    ) public {
        rate = uint96(bound(rate, 1, 1e12));
        maxPerCharge = uint96(bound(maxPerCharge, 1, type(uint96).max));
        uint256 e = bound(elapsed, 1, 365 days);
        uint256 id = _open(rate, maxPerCharge, type(uint96).max, 0);
        address by = [payer, merchant, manager][role % 3];

        if (!funded) _starve(false);
        vm.warp(T0 + e);
        if (!funded) {
            vm.expectEmit(address(hub));
            emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, _min2(rate * e, maxPerCharge));
        }
        vm.prank(by);
        hub.cancelMandate(id);

        uint256 expected = funded ? _min2(rate * e, maxPerCharge) : 0;
        assertEq(usd.balanceOf(merchant), expected, "settles what accrued when it can");
        assertEq(hub.getMandate(id).totalCharged, expected, "books only what moved");
        assertEq(uint8(hub.getMandate(id).status), uint8(IMandateHub.Status.Cancelled), "cancelled either way");

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        hub.charge(id);
    }

    /*//////////////////////////////////////////////////////////////
                               SEQUENCES
    //////////////////////////////////////////////////////////////*/

    /// @dev Each op is a warp, a charge, a pause or a resume, chosen by its low two bits. The hub
    ///      must agree with the reference model after every step, and the model's bounds are the
    ///      specification's: per-charge cap, rate times seconds since the checkpoint, lifetime cap,
    ///      rate times seconds actually run.
    function testFuzz_sequenceNeverOverbills(uint96 rate, uint96 maxPerCharge, uint96 maxTotal, uint256[24] memory ops)
        public
    {
        Stream memory s = Stream({
            id: 0,
            rate: bound(rate, 1, 1e12),
            maxPerCharge: bound(maxPerCharge, 1, type(uint96).max),
            maxTotal: bound(maxTotal, 1, type(uint96).max)
        });
        s.id = _open(uint96(s.rate), uint96(s.maxPerCharge), uint96(s.maxTotal), 0);
        Model memory m = Model({checkpoint: T0, pausedAt: 0, running: 0, total: 0});

        for (uint256 i = 0; i < ops.length; ++i) {
            uint256 kind = ops[i] % 4;
            if (kind == 0) _stepWarp(m, ops[i] >> 2);
            else if (kind == 1) _stepCharge(s, m);
            else if (kind == 2) _stepPause(s, m);
            else _stepResume(s, m);

            _assertAgrees(s, m);
        }
    }

    /*//////////////////////////////////////////////////////////////
                              SUSPECTED BUG
    //////////////////////////////////////////////////////////////*/

    /// @dev SUSPECTED BUG, fails today. A stream with a future `startAt` that is paused and resumed
    ///      before its start has paused nothing billable, yet `_resume` still shifts the checkpoint
    ///      by the whole paused interval. The stream then runs unpaused from `max(startAt, resume)`
    ///      but accrues only from `startAt + (resume - pause)`, so the merchant is never paid for
    ///      that stretch. A payer can use it deliberately: pause at creation, resume just before
    ///      the start, and receive about a start-lead's worth of service for free. `startAt` is
    ///      documented as "the moment accrual begins for a streaming one".
    function testFuzz_pauseBeforeStartDoesNotDelayAccrual(
        uint96 rate,
        uint32 lead,
        uint32 pauseAfter,
        uint32 pausedFor,
        uint32 runFor
    ) public {
        rate = uint96(bound(rate, 1, 1e12));
        uint256 start = T0 + bound(lead, 2, 30 days);
        uint256 id = _open(rate, type(uint96).max, type(uint96).max, uint64(start));

        vm.warp(T0 + bound(pauseAfter, 0, start - T0 - 1));
        vm.prank(payer);
        hub.pauseMandate(id);

        vm.warp(block.timestamp + bound(pausedFor, 1, 60 days));
        vm.prank(payer);
        hub.resumeMandate(id);

        uint256 billableFrom = block.timestamp > start ? block.timestamp : start;
        vm.warp(billableFrom + bound(runFor, 1, 30 days));

        assertEq(
            hub.quoteCharge(id),
            rate * (block.timestamp - billableFrom),
            "a stream running unpaused since max(start, resume) is owed all of that time"
        );
    }

    /*//////////////////////////////////////////////////////////////
                              MODEL STEPS
    //////////////////////////////////////////////////////////////*/

    function _stepWarp(Model memory m, uint256 seed) internal {
        uint256 dt = bound(seed, 1, 2 days);
        if (m.pausedAt == 0) m.running += dt;
        vm.warp(block.timestamp + dt);
    }

    function _stepCharge(Stream memory s, Model memory m) internal {
        if (m.pausedAt != 0) {
            vm.expectRevert(IMandateHub.MandateIsPaused.selector);
            hub.charge(s.id);
            return;
        }
        if (block.timestamp <= m.checkpoint) {
            vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, m.checkpoint, block.timestamp));
            hub.charge(s.id);
            return;
        }
        if (m.total >= s.maxTotal) {
            vm.expectRevert(abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, m.total, s.maxTotal));
            hub.charge(s.id);
            return;
        }

        uint256 accrued = s.rate * (block.timestamp - m.checkpoint);
        uint256 before = usd.balanceOf(merchant);
        hub.charge(s.id);
        uint256 took = usd.balanceOf(merchant) - before;

        assertEq(took, _min3(accrued, s.maxPerCharge, s.maxTotal - m.total), "charge matches the model");
        assertLe(took, s.maxPerCharge, "a charge never exceeds maxPerCharge");
        assertLe(took, accrued, "a charge never exceeds rate times seconds since the checkpoint");
        m.total += took;
        m.checkpoint = block.timestamp;
    }

    function _stepPause(Stream memory s, Model memory m) internal {
        if (m.pausedAt != 0) {
            vm.expectRevert(IMandateHub.MandateIsPaused.selector);
            vm.prank(payer);
            hub.pauseMandate(s.id);
            return;
        }

        uint256 settles;
        if (block.timestamp > m.checkpoint && m.total < s.maxTotal) {
            settles = _min3(s.rate * (block.timestamp - m.checkpoint), s.maxPerCharge, s.maxTotal - m.total);
        }
        uint256 before = usd.balanceOf(merchant);
        vm.prank(payer);
        hub.pauseMandate(s.id);

        assertEq(usd.balanceOf(merchant) - before, settles, "pause settles exactly the accrual");
        if (settles != 0) {
            m.total += settles;
            m.checkpoint = block.timestamp;
        }
        m.pausedAt = block.timestamp;
    }

    function _stepResume(Stream memory s, Model memory m) internal {
        if (m.pausedAt == 0) {
            vm.expectRevert(IMandateHub.MandateNotPaused.selector);
            vm.prank(manager);
            hub.resumeMandate(s.id);
            return;
        }

        uint256 before = usd.balanceOf(merchant);
        vm.prank(manager);
        hub.resumeMandate(s.id);

        assertEq(usd.balanceOf(merchant), before, "resume moves nothing");
        m.checkpoint += block.timestamp - m.pausedAt;
        m.pausedAt = 0;
    }

    function _assertAgrees(Stream memory s, Model memory m) internal view {
        IMandateHub.Mandate memory h = hub.getMandate(s.id);
        assertEq(h.nextChargeAt, m.checkpoint, "checkpoint");
        assertEq(h.pausedAt, m.pausedAt, "pausedAt");
        assertEq(h.totalCharged, m.total, "totalCharged");
        assertEq(usd.balanceOf(merchant), m.total, "merchant received exactly the total");
        assertLe(m.total, s.maxTotal, "within the lifetime cap");
        assertLe(m.total, s.rate * m.running, "never more than rate times seconds actually run");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A stream on `usd` with the given rate and caps and a distant expiry. `startAt` zero
    ///      means the creation block.
    function _open(uint96 rate, uint96 maxPerCharge, uint96 maxTotal, uint64 startAt) internal returns (uint256) {
        IMandateHub.Terms memory t = perSecond();
        t.amount = rate;
        t.maxPerCharge = maxPerCharge;
        t.maxTotal = maxTotal;
        t.startAt = startAt;
        t.expiresAt = FAR;
        return create(t);
    }

    function _starve(bool allowanceShort) internal {
        if (allowanceShort) {
            vm.prank(payer);
            usd.approve(address(hub), 0);
        } else {
            deal(address(usd), payer, 0);
        }
    }

    function _refund() internal {
        deal(address(usd), payer, type(uint128).max);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
    }

    function _min2(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return _min2(_min2(a, b), c);
    }
}
