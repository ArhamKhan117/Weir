// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubViewsTest
/// @notice `isChargeable` and `quoteCharge` answer exactly what a charge would do on the terms,
///         so a keeper can trust them, and they ignore funding so delinquency keeps being retried.
contract MandateHubViewsTest is HubFixture {
    function test_unknownMandateReadsAsZero() public view {
        IMandateHub.Mandate memory m = mandate(7);
        assertEq(m.payer, address(0));
        assertFalse(hub.isChargeable(7));
        assertEq(hub.quoteCharge(7), 0);
    }

    function test_periodicIsChargeableAtItsBoundary() public {
        uint256 id = create(monthly());
        assertTrue(hub.isChargeable(id));
        assertEq(hub.quoteCharge(id), 10 * DOLLAR);

        hub.charge(id);
        assertFalse(hub.isChargeable(id));
        assertEq(hub.quoteCharge(id), 0);

        vm.warp(T0 + MONTH);
        assertTrue(hub.isChargeable(id));
    }

    function test_periodicWithAFutureStartIsNotChargeableYet() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 + 7 days;
        uint256 id = create(t);

        assertFalse(hub.isChargeable(id));
        vm.warp(T0 + 7 days);
        assertTrue(hub.isChargeable(id));
    }

    function test_notChargeableOnceTheTotalCapIsSpent() public {
        IMandateHub.Terms memory t = monthly();
        t.maxTotal = t.amount;
        uint256 id = create(t);

        hub.charge(id);
        vm.warp(T0 + MONTH);
        assertFalse(hub.isChargeable(id));
    }

    function test_notChargeableAfterExpiry() public {
        uint256 id = create(monthly());
        vm.warp(mandate(id).expiresAt + 1);
        assertFalse(hub.isChargeable(id));
        assertEq(hub.quoteCharge(id), 0);
    }

    function test_notChargeableWhenCancelled() public {
        uint256 id = create(monthly());
        vm.prank(payer);
        hub.cancelMandate(id);
        assertFalse(hub.isChargeable(id));
    }

    function test_fundingDoesNotAffectChargeability() public {
        uint256 id = create(monthly());
        vm.prank(payer);
        usd.approve(address(hub), 0);

        assertTrue(hub.isChargeable(id));
        hub.charge(id);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
        assertTrue(hub.isChargeable(id));
    }

    function test_streamQuoteGrowsWithTime() public {
        uint256 id = create(perSecond());
        assertEq(hub.quoteCharge(id), 0);

        vm.warp(T0 + 10);
        assertEq(hub.quoteCharge(id), 1_000);
        vm.warp(T0 + 100);
        assertEq(hub.quoteCharge(id), 10_000);
    }

    function test_streamQuoteIsClamped() public {
        uint256 id = create(perSecond());
        vm.warp(T0 + 30 hours);
        assertEq(hub.quoteCharge(id), 5 * DOLLAR);
    }

    function test_quoteMatchesWhatAChargeMoves() public {
        uint256 id = create(perSecond());
        vm.warp(T0 + 777);
        uint256 quoted = hub.quoteCharge(id);

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), quoted);
    }
}
