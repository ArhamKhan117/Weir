// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE
} from "../../src/interfaces/IMandateHub.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubChargeTest
/// @notice Periodic charging: exactly `amount`, straight from payer to merchant, once per period,
///         never past a cap or the expiry, and a charge the payer cannot fund changes nothing but
///         the status.
contract MandateHubChargeTest is HubFixture {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = create(monthly());
    }

    function test_movesExactlyTheAmountToTheMerchant() public {
        uint256 payerBefore = usd.balanceOf(payer);

        vm.prank(relayer);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(payer), payerBefore - 10 * DOLLAR);
        assertEq(usd.balanceOf(address(hub)), 0);
    }

    function test_advancesTheScheduleAndTheTotal() public {
        hub.charge(id);

        IMandateHub.Mandate memory m = mandate(id);
        assertEq(m.nextChargeAt, T0 + MONTH);
        assertEq(m.totalCharged, 10 * DOLLAR);
    }

    function test_emitsCharged() public {
        vm.expectEmit(address(hub));
        emit IMandateHub.Charged(id, merchant, 10 * DOLLAR, 10 * DOLLAR, T0 + MONTH);
        hub.charge(id);
    }

    function test_revertsBeforeTheNextBoundary() public {
        hub.charge(id);
        vm.warp(T0 + MONTH - 1);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NotDue.selector, T0 + MONTH, T0 + MONTH - 1));
        hub.charge(id);
    }

    function test_chargesAgainAtTheBoundary() public {
        hub.charge(id);
        vm.warp(T0 + MONTH);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 20 * DOLLAR);
        assertEq(mandate(id).nextChargeAt, T0 + 2 * MONTH);
    }

    function test_skipsMissedPeriodsRatherThanOwingThem() public {
        vm.warp(T0 + 3 * MONTH + 5 days);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(mandate(id).nextChargeAt, T0 + 4 * MONTH);
    }

    function test_revertsPastTheLifetimeCap() public {
        IMandateHub.Terms memory t = monthly();
        t.maxTotal = 25 * DOLLAR;
        uint256 capped = create(t);

        hub.charge(capped);
        vm.warp(T0 + MONTH);
        hub.charge(capped);
        vm.warp(T0 + 2 * MONTH);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, 20 * DOLLAR, 25 * DOLLAR));
        hub.charge(capped);
    }

    function test_revertsAfterExpiry() public {
        uint64 expiresAt = mandate(id).expiresAt;
        vm.warp(expiresAt + 1);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.MandateExpired.selector, expiresAt, expiresAt + 1));
        hub.charge(id);
    }

    function test_chargesAtTheExpiryInstant() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 + 10 days;
        t.expiresAt = T0 + 10 days;
        uint256 lastDay = create(t);

        vm.warp(T0 + 10 days);
        hub.charge(lastDay);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_revertsOnUnknownMandate() public {
        vm.expectRevert(IMandateHub.UnknownMandate.selector);
        hub.charge(99);
    }

    function test_revertsWhenCancelled() public {
        vm.prank(payer);
        hub.cancelMandate(id);

        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        hub.charge(id);
    }

    function test_revertsWhenTheTokenRefusesDespitePreChecks() public {
        IMandateHub.Terms memory t = monthly();
        t.asset = address(refusing);
        uint256 rid = create(t);
        refusing.setMode(RefusingToken.Mode.Revert);

        vm.expectRevert("RefusingToken: refused");
        hub.charge(rid);
        assertEq(mandate(rid).totalCharged, 0);
    }

    function test_revertsWhenTheTokenReturnsFalse() public {
        IMandateHub.Terms memory t = monthly();
        t.asset = address(refusing);
        uint256 rid = create(t);
        refusing.setMode(RefusingToken.Mode.ReturnFalse);

        vm.expectRevert();
        hub.charge(rid);
        assertEq(mandate(rid).totalCharged, 0);
    }

    /*//////////////////////////////////////////////////////////////
                               DELINQUENCY
    //////////////////////////////////////////////////////////////*/

    function _drain() internal {
        uint256 balance = usd.balanceOf(payer);
        vm.prank(payer);
        usd.transfer(stranger, balance - 1);
    }

    function test_shortBalanceFailsWithoutReverting() public {
        _drain();

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, 10 * DOLLAR);
        hub.charge(id);

        IMandateHub.Mandate memory m = mandate(id);
        assertEq(uint8(m.status), uint8(IMandateHub.Status.Delinquent));
        assertEq(m.nextChargeAt, T0);
        assertEq(m.totalCharged, 0);
        assertEq(usd.balanceOf(merchant), 0);
    }

    function test_shortAllowanceFailsWithoutReverting() public {
        vm.prank(payer);
        usd.approve(address(hub), 10 * DOLLAR - 1);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_ALLOWANCE, 10 * DOLLAR);
        hub.charge(id);

        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
        assertEq(usd.balanceOf(merchant), 0);
    }

    function test_revokingTheAllowanceStopsEveryCharge() public {
        vm.prank(payer);
        usd.approve(address(hub), 0);

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 0);
    }

    function test_delinquentStaysChargeableAndRecovers() public {
        _drain();
        hub.charge(id);
        assertTrue(hub.isChargeable(id));

        usd.mint(payer, 10 * DOLLAR);
        hub.charge(id);

        IMandateHub.Mandate memory m = mandate(id);
        assertEq(uint8(m.status), uint8(IMandateHub.Status.Active));
        assertEq(m.totalCharged, 10 * DOLLAR);
        assertEq(m.nextChargeAt, T0 + MONTH);
    }

    function test_repeatedFailureStaysDelinquent() public {
        _drain();
        hub.charge(id);
        hub.charge(id);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
    }
}
