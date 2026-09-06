// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubCreateTest
/// @notice `createMandate` stores exactly the agreed terms, emits all of them, and refuses every
///         term that could never be charged or would hand out more than it should.
contract MandateHubCreateTest is HubFixture {
    function test_storesPeriodicTerms() public {
        IMandateHub.Terms memory t = monthly();
        uint256 id = create(t);

        IMandateHub.Mandate memory m = mandate(id);
        assertEq(id, 1);
        assertEq(m.payer, payer);
        assertEq(m.merchant, merchant);
        assertEq(m.asset, address(usd));
        assertEq(m.vault, address(0));
        assertEq(m.manager, manager);
        assertEq(m.amount, t.amount);
        assertEq(m.period, t.period);
        assertEq(m.nextChargeAt, T0);
        assertEq(m.maxPerCharge, t.maxPerCharge);
        assertEq(m.maxTotal, t.maxTotal);
        assertEq(m.expiresAt, t.expiresAt);
        assertEq(m.totalCharged, 0);
        assertEq(m.pausedAt, 0);
        assertEq(uint8(m.status), uint8(IMandateHub.Status.Active));
    }

    function test_emitsEveryTerm() public {
        IMandateHub.Terms memory t = monthly();

        vm.expectEmit(address(hub));
        emit IMandateHub.MandateCreated(
            1,
            payer,
            merchant,
            address(usd),
            address(0),
            manager,
            t.amount,
            t.period,
            T0,
            t.maxPerCharge,
            t.maxTotal,
            t.expiresAt,
            t.ref
        );
        create(t);
    }

    function test_idsIncrease() public {
        assertEq(create(monthly()), 1);
        assertEq(create(perSecond()), 2);
        assertEq(hub.nextMandateId(), 3);
    }

    function test_futureStartIsTheFirstBoundary() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 + 7 days;

        assertEq(mandate(create(t)).nextChargeAt, T0 + 7 days);
    }

    function test_pastStartAnchorsAPeriodicSchedule() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 - 10 days;

        uint256 id = create(t);
        assertEq(mandate(id).nextChargeAt, T0 - 10 days);
        assertTrue(hub.isChargeable(id));
    }

    function test_streamNeverAccruesBeforeItExists() public {
        IMandateHub.Terms memory t = perSecond();
        t.startAt = T0 - 10 days;

        uint256 id = create(t);
        assertEq(mandate(id).nextChargeAt, T0);
        assertFalse(hub.isChargeable(id));
    }

    function test_noManagerIsAllowed() public {
        IMandateHub.Terms memory t = monthly();
        t.manager = address(0);

        assertEq(mandate(create(t)).manager, address(0));
    }

    function test_acceptsEveryDeployedAsset() public {
        IMandateHub.Terms memory t = monthly();
        t.asset = address(ausd);

        assertEq(mandate(create(t)).asset, address(ausd));
    }

    function test_totalCapOfOneChargeIsLegal() public {
        IMandateHub.Terms memory t = monthly();
        t.maxTotal = t.amount;

        create(t);
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _expectCreateRevert(IMandateHub.Terms memory t, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(payer);
        hub.createMandate(t);
        assertEq(hub.nextMandateId(), 1);
    }

    function test_revertsOnUnknownAsset() public {
        IMandateHub.Terms memory t = monthly();
        t.asset = address(0xBEEF);
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidAsset.selector, address(0xBEEF)));
    }

    function test_revertsOnZeroMerchant() public {
        IMandateHub.Terms memory t = monthly();
        t.merchant = address(0);
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector));
    }

    function test_revertsWhenPayerIsMerchant() public {
        IMandateHub.Terms memory t = monthly();
        t.merchant = payer;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector));
    }

    function test_revertsWhenTheHubIsTheMerchant() public {
        IMandateHub.Terms memory t = monthly();
        t.merchant = address(hub);
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector));
    }

    function test_revertsOnZeroAmount() public {
        IMandateHub.Terms memory t = monthly();
        t.amount = 0;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidAmount.selector));
    }

    function test_revertsOnPeriodBelowMinimum() public {
        IMandateHub.Terms memory t = monthly();
        t.period = hub.MIN_PERIOD() - 1;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidPeriod.selector));
    }

    function test_revertsOnPeriodAboveMaximum() public {
        IMandateHub.Terms memory t = monthly();
        t.period = hub.MAX_PERIOD() + 1;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidPeriod.selector));
    }

    function test_periodBoundsAreInclusive() public {
        IMandateHub.Terms memory t = monthly();
        t.period = hub.MIN_PERIOD();
        create(t);
        t.period = hub.MAX_PERIOD();
        t.expiresAt = T0 + 2 * uint64(hub.MAX_PERIOD());
        create(t);
    }

    function test_revertsOnZeroPerChargeCap() public {
        IMandateHub.Terms memory t = perSecond();
        t.maxPerCharge = 0;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidChargeCap.selector));
    }

    function test_revertsWhenPerChargeCapIsBelowAPeriodicAmount() public {
        IMandateHub.Terms memory t = monthly();
        t.maxPerCharge = t.amount - 1;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidChargeCap.selector));
    }

    function test_streamPerChargeCapMayBeBelowTheRate() public {
        IMandateHub.Terms memory t = perSecond();
        t.maxPerCharge = t.amount - 1;
        create(t);
    }

    function test_revertsWhenTotalCapCannotCoverOnePeriodicCharge() public {
        IMandateHub.Terms memory t = monthly();
        t.maxTotal = t.amount - 1;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidTotalCap.selector));
    }

    function test_revertsOnZeroStreamTotalCap() public {
        IMandateHub.Terms memory t = perSecond();
        t.maxTotal = 0;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidTotalCap.selector));
    }

    function test_revertsWhenAlreadyExpired() public {
        IMandateHub.Terms memory t = monthly();
        t.expiresAt = T0;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }

    function test_revertsWhenExpiryPrecedesTheFirstCharge() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 + 10 days;
        t.expiresAt = T0 + 10 days - 1;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }

    function test_periodicMayExpireAtItsFirstCharge() public {
        IMandateHub.Terms memory t = monthly();
        t.startAt = T0 + 10 days;
        t.expiresAt = T0 + 10 days;
        create(t);
    }

    function test_revertsWhenAStreamCouldNeverAccrue() public {
        IMandateHub.Terms memory t = perSecond();
        t.startAt = T0 + 10 days;
        t.expiresAt = T0 + 10 days;
        _expectCreateRevert(t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }
}
