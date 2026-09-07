// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub, REASON_INSUFFICIENT_BALANCE, REASON_TRANSFER_REFUSED} from "../../src/interfaces/IMandateHub.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubStreamTest
/// @notice Streaming: a charge takes the rate times the seconds since the checkpoint, clamped to
///         both caps; paused time is never billed; stopping a stream pays for the time used.
contract MandateHubStreamTest is HubFixture {
    uint256 internal id;

    /// @dev `perSecond()` accrues 100 base units a second: $0.36 an hour.
    uint96 internal constant RATE = 100;

    function setUp() public override {
        super.setUp();
        id = create(perSecond());
    }

    function test_notDueAtTheCheckpoint() public {
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0, T0));
        hub.charge(id);
        assertEq(hub.quoteCharge(id), 0);
    }

    function test_chargesTheRateTimesElapsed() public {
        vm.warp(T0 + 1 hours);
        assertEq(hub.quoteCharge(id), RATE * 1 hours);

        hub.charge(id);

        assertEq(usd.balanceOf(merchant), RATE * 1 hours);
        assertEq(mandate(id).nextChargeAt, T0 + 1 hours);
        assertEq(mandate(id).totalCharged, RATE * 1 hours);
    }

    function test_chargesOneSecondAtATime() public {
        vm.warp(T0 + 1);
        hub.charge(id);
        vm.warp(T0 + 2);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 2 * RATE);
    }

    function test_secondChargeInTheSameBlockIsNotDue() public {
        vm.warp(T0 + 60);
        hub.charge(id);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0 + 60, T0 + 60));
        hub.charge(id);
    }

    function test_clampsToThePerChargeCapAndForfeitsTheRest() public {
        // 100 units/s for 20 hours accrues $7.20, above the $5 cap.
        vm.warp(T0 + 20 hours);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 5 * DOLLAR);
        assertEq(mandate(id).nextChargeAt, T0 + 20 hours);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0 + 20 hours, T0 + 20 hours));
        hub.charge(id);
    }

    function test_clampsToWhatTheLifetimeCapHasLeft() public {
        IMandateHub.Terms memory t = perSecond();
        t.maxTotal = RATE * 90;
        uint256 small = create(t);

        vm.warp(T0 + 60);
        hub.charge(small);
        vm.warp(T0 + 120);
        hub.charge(small);

        assertEq(mandate(small).totalCharged, RATE * 90);
        assertFalse(hub.isChargeable(small));

        vm.warp(T0 + 180);
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, RATE * 90, RATE * 90));
        hub.charge(small);
    }

    function test_futureStartAccruesFromThen() public {
        IMandateHub.Terms memory t = perSecond();
        t.startAt = T0 + 1 days;
        uint256 later = create(t);

        vm.warp(T0 + 1 days);
        assertFalse(hub.isChargeable(later));

        vm.warp(T0 + 1 days + 10);
        hub.charge(later);
        assertEq(usd.balanceOf(merchant), RATE * 10);
    }

    function test_noChargeAfterExpiry() public {
        uint64 expiresAt = mandate(id).expiresAt;
        vm.warp(expiresAt + 1);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.MandateExpired.selector, expiresAt, expiresAt + 1));
        hub.charge(id);
    }

    function test_shortBalanceKeepsAccruing() public {
        uint256 balance = usd.balanceOf(payer);
        vm.prank(payer);
        usd.transfer(stranger, balance);

        vm.warp(T0 + 60);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, RATE * 60);
        hub.charge(id);
        assertEq(mandate(id).nextChargeAt, T0);

        usd.mint(payer, DOLLAR);
        vm.warp(T0 + 120);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), RATE * 120);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Active));
    }

    /*//////////////////////////////////////////////////////////////
                              PAUSE, RESUME
    //////////////////////////////////////////////////////////////*/

    function test_pauseSettlesWhatAccrued() public {
        vm.warp(T0 + 600);
        vm.prank(payer);
        hub.pauseMandate(id);

        assertEq(usd.balanceOf(merchant), RATE * 600);
        assertEq(mandate(id).pausedAt, T0 + 600);
        assertEq(mandate(id).nextChargeAt, T0 + 600);
    }

    function test_pausedStreamCannotBeCharged() public {
        vm.prank(manager);
        hub.pauseMandate(id);
        vm.warp(T0 + 1 hours);

        assertFalse(hub.isChargeable(id));
        assertEq(hub.quoteCharge(id), 0);
        vm.expectRevert(IMandateHub.MandateIsPaused.selector);
        hub.charge(id);
    }

    function test_pausedTimeIsNeverBilled() public {
        vm.warp(T0 + 100);
        vm.prank(manager);
        hub.pauseMandate(id);

        vm.warp(T0 + 100 + 1 days);
        vm.prank(manager);
        hub.resumeMandate(id);
        assertEq(mandate(id).nextChargeAt, T0 + 100 + 1 days);

        vm.warp(T0 + 100 + 1 days + 50);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), RATE * 150);
    }

    function test_unpaidPrePauseAccrualStaysOwedAfterResume() public {
        vm.prank(payer);
        usd.approve(address(hub), 0);

        vm.warp(T0 + 100);
        vm.prank(payer);
        hub.pauseMandate(id);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));

        vm.warp(T0 + 1000);
        vm.prank(payer);
        hub.resumeMandate(id);
        assertEq(mandate(id).nextChargeAt, T0 + 900);

        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
        vm.warp(T0 + 1010);
        hub.charge(id);

        // 100 seconds before the pause plus 10 after the resume.
        assertEq(usd.balanceOf(merchant), RATE * 110);
    }

    function test_pauseGoesAheadWhenTheTokenRefuses() public {
        IMandateHub.Terms memory t = perSecond();
        t.asset = address(refusing);
        uint256 rid = create(t);
        refusing.setMode(RefusingToken.Mode.Revert);

        vm.warp(T0 + 60);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(rid, REASON_TRANSFER_REFUSED, RATE * 60);
        vm.prank(payer);
        hub.pauseMandate(rid);

        assertEq(mandate(rid).pausedAt, T0 + 60);
        assertEq(mandate(rid).totalCharged, 0);
    }

    function test_pauseTwiceReverts() public {
        vm.startPrank(payer);
        hub.pauseMandate(id);
        vm.expectRevert(IMandateHub.MandateIsPaused.selector);
        hub.pauseMandate(id);
        vm.stopPrank();
    }

    function test_resumeWhileRunningReverts() public {
        vm.prank(payer);
        vm.expectRevert(IMandateHub.MandateNotPaused.selector);
        hub.resumeMandate(id);
    }

    function test_pauseIsForStreamsOnly() public {
        uint256 monthlyId = create(monthly());

        vm.startPrank(payer);
        vm.expectRevert(IMandateHub.NotStreaming.selector);
        hub.pauseMandate(monthlyId);
        vm.expectRevert(IMandateHub.NotStreaming.selector);
        hub.resumeMandate(monthlyId);
        vm.stopPrank();
    }

    function test_pauseAndResumeBeforeStartLeaveTheStartAlone() public {
        IMandateHub.Terms memory t = perSecond();
        t.startAt = T0 + 1 hours;
        uint256 later = create(t);

        vm.prank(payer);
        hub.pauseMandate(later);
        vm.warp(T0 + 30 minutes);
        vm.prank(payer);
        hub.resumeMandate(later);

        assertEq(mandate(later).nextChargeAt, T0 + 1 hours);
    }

    function test_resumeAfterStartBillsFromTheResume() public {
        IMandateHub.Terms memory t = perSecond();
        t.startAt = T0 + 1 hours;
        uint256 later = create(t);

        vm.prank(payer);
        hub.pauseMandate(later);
        vm.warp(T0 + 90 minutes);
        vm.prank(payer);
        hub.resumeMandate(later);

        assertEq(mandate(later).nextChargeAt, T0 + 90 minutes);
        vm.warp(T0 + 90 minutes + 10);
        hub.charge(later);
        assertEq(usd.balanceOf(merchant), RATE * 10);
    }

    /*//////////////////////////////////////////////////////////////
                                  CANCEL
    //////////////////////////////////////////////////////////////*/

    function test_cancelPaysForTimeUsed() public {
        vm.warp(T0 + 300);
        vm.prank(payer);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), RATE * 300);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Cancelled));
    }

    function test_merchantCancelAlsoSettles() public {
        vm.warp(T0 + 300);
        vm.prank(merchant);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), RATE * 300);
    }

    function test_cancelGoesAheadWhenThePayerCannotPay() public {
        vm.prank(payer);
        usd.approve(address(hub), 0);

        vm.warp(T0 + 300);
        vm.prank(payer);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), 0);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Cancelled));
    }

    function test_cancelAfterExpirySettlesNothing() public {
        vm.warp(mandate(id).expiresAt + 1);
        vm.prank(payer);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), 0);
    }

    function test_cancelWhilePausedSettlesNothingMore() public {
        vm.warp(T0 + 100);
        vm.prank(payer);
        hub.pauseMandate(id);
        vm.warp(T0 + 1 days);
        vm.prank(payer);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), RATE * 100);
    }
}
