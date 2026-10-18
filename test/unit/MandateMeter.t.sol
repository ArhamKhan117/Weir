// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {MeterFixture} from "../helpers/MeterFixture.sol";
import {MandateMeter} from "../../src/MandateMeter.sol";
import {
    IMandateMeter,
    METER_REASON_INSUFFICIENT_BALANCE,
    METER_REASON_INSUFFICIENT_ALLOWANCE
} from "../../src/interfaces/IMandateMeter.sol";
import {MockSmartWallet} from "../mocks/MockSmartWallet.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";

contract MandateMeterTest is MeterFixture {
    /*//////////////////////////////////////////////////////////////
                                 DEPLOY
    //////////////////////////////////////////////////////////////*/

    function test_typeStrings_arePinned() public view {
        // These strings are also in packages/shared/src/eip712.ts; a drift breaks every signature.
        string memory terms =
            "MeterTerms(address merchant,address asset,address manager,uint96 periodCap,uint32 period,uint96 maxTotal,uint64 expiresAt,bytes32 ref)";
        assertEq(meter.TERMS_TYPEHASH(), keccak256(bytes(terms)));
        assertEq(
            meter.AUTHORIZATION_TYPEHASH(),
            keccak256(
                bytes(
                    string.concat(
                        "MeterAuthorization(address payer,MeterTerms terms,uint256 nonce,uint256 deadline)", terms
                    )
                )
            )
        );
        assertEq(meter.RECEIPT_TYPEHASH(), keccak256("UsageReceipt(uint256 meterId,uint96 total,uint64 issuedAt)"));
        assertEq(meter.CANCEL_TYPEHASH(), keccak256("MeterCancel(uint256 meterId,uint256 nonce,uint256 deadline)"));
    }

    function test_constructor_rejectsNoAssetsZeroAndDuplicates() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.InvalidAsset.selector, address(0)));
        new MandateMeter("Weir", "1", none);

        address[] memory dup = new address[](2);
        dup[0] = address(usd);
        dup[1] = address(usd);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.InvalidAsset.selector, address(usd)));
        new MandateMeter("Weir", "1", dup);

        address[] memory zero = new address[](1);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.InvalidAsset.selector, address(0)));
        new MandateMeter("Weir", "1", zero);
    }

    function test_acceptedAssets() public view {
        address[] memory assets = meter.acceptedAssets();
        assertEq(assets.length, 3);
        assertTrue(meter.isAcceptedAsset(address(usd)));
        assertFalse(meter.isAcceptedAsset(stranger));
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATION
    //////////////////////////////////////////////////////////////*/

    function test_create_recordsTermsAndEmits() public {
        IMandateMeter.Terms memory t = perCall();
        vm.expectEmit(address(meter));
        emit IMandateMeter.MeterCreated(
            1, payer, merchant, address(usd), manager, 5 * DOLLAR, DAY, 20 * DOLLAR, t.expiresAt, t.ref
        );
        uint256 id = open(t);

        assertEq(id, 1);
        assertEq(meter.nextMeterId(), 2);
        IMandateMeter.Meter memory m = state(id);
        assertEq(m.payer, payer);
        assertEq(m.merchant, merchant);
        assertEq(m.asset, address(usd));
        assertEq(m.manager, manager);
        assertEq(m.periodCap, 5 * DOLLAR);
        assertEq(m.period, DAY);
        assertEq(m.maxTotal, 20 * DOLLAR);
        assertEq(m.expiresAt, t.expiresAt);
        assertEq(m.periodStart, T0);
        assertEq(m.totalCharged, 0);
        assertEq(uint8(m.status), uint8(IMandateMeter.Status.Active));
    }

    function test_create_rejectsBadTerms() public {
        IMandateMeter.Terms memory t = perCall();
        t.merchant = address(0);
        vm.expectRevert(IMandateMeter.InvalidMerchant.selector);
        open(t);

        t = perCall();
        t.merchant = address(meter);
        vm.expectRevert(IMandateMeter.InvalidMerchant.selector);
        open(t);

        t = perCall();
        t.asset = stranger;
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.InvalidAsset.selector, stranger));
        open(t);

        t = perCall();
        t.period = 59;
        vm.expectRevert(IMandateMeter.InvalidPeriod.selector);
        open(t);

        t = perCall();
        t.period = 31_536_001;
        vm.expectRevert(IMandateMeter.InvalidPeriod.selector);
        open(t);

        t = perCall();
        t.maxTotal = 0;
        vm.expectRevert(IMandateMeter.InvalidTotalCap.selector);
        open(t);

        t = perCall();
        t.periodCap = 0;
        vm.expectRevert(IMandateMeter.InvalidPeriodCap.selector);
        open(t);

        t = perCall();
        t.periodCap = t.maxTotal + 1;
        vm.expectRevert(IMandateMeter.InvalidPeriodCap.selector);
        open(t);

        t = perCall();
        t.expiresAt = T0;
        vm.expectRevert(IMandateMeter.InvalidExpiry.selector);
        open(t);
    }

    function test_createWithSig_opensForTheSigner() public {
        IMandateMeter.Terms memory t = perCall();
        bytes memory sig = sign(PAYER_KEY, meter.hashCreate(payer, t, 7, T0 + 1 hours));
        vm.prank(relayer);
        uint256 id = meter.createMeterWithSig(payer, t, 7, T0 + 1 hours, sig);
        assertEq(state(id).payer, payer);
        assertTrue(meter.nonceUsed(payer, 7));

        // The same signature cannot open a second meter.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.NonceAlreadyUsed.selector, payer, 7));
        meter.createMeterWithSig(payer, t, 7, T0 + 1 hours, sig);
    }

    function test_createWithSig_rejectsWrongSignerExpiryAndTampering() public {
        IMandateMeter.Terms memory t = perCall();
        bytes memory theirs = sign(STRANGER_KEY, meter.hashCreate(payer, t, 1, T0 + 1 hours));
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.createMeterWithSig(payer, t, 1, T0 + 1 hours, theirs);

        bytes memory sig = sign(PAYER_KEY, meter.hashCreate(payer, t, 1, T0 + 1 hours));
        IMandateMeter.Terms memory widened = perCall();
        widened.maxTotal = 1_000 * DOLLAR;
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.createMeterWithSig(payer, widened, 1, T0 + 1 hours, sig);

        vm.warp(T0 + 1 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.SignatureExpired.selector, T0 + 1 hours, T0 + 1 hours + 1));
        meter.createMeterWithSig(payer, t, 1, T0 + 1 hours, sig);
    }

    function test_createWithSig_acceptsASmartAccount() public {
        MockSmartWallet wallet = new MockSmartWallet(payer);
        IMandateMeter.Terms memory t = perCall();
        bytes memory sig = sign(PAYER_KEY, meter.hashCreate(address(wallet), t, 1, T0 + 1 hours));
        uint256 id = meter.createMeterWithSig(address(wallet), t, 1, T0 + 1 hours, sig);
        assertEq(state(id).payer, address(wallet));
    }

    /*//////////////////////////////////////////////////////////////
                                SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function test_settle_paysTheDifferenceEachTime() public {
        uint256 id = open(perCall());

        vm.expectEmit(address(meter));
        emit IMandateMeter.UsageSettled(id, merchant, 37 * CENT, 37 * CENT, 37 * CENT);
        assertEq(settle(id, 37 * CENT), 37 * CENT);
        assertEq(usd.balanceOf(merchant), 37 * CENT);

        vm.warp(T0 + 10);
        assertEq(settle(id, 1 * DOLLAR), 63 * CENT);
        assertEq(usd.balanceOf(merchant), 1 * DOLLAR);
        assertEq(state(id).totalCharged, 1 * DOLLAR);
        assertEq(usd.balanceOf(address(meter)), 0);
    }

    function test_settle_oldOrEqualReceiptsMoveNothing() public {
        uint256 id = open(perCall());
        IMandateMeter.Receipt memory r = receipt(id, 50 * CENT);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        meter.settle(r, sig);

        vm.expectRevert(IMandateMeter.NothingToSettle.selector);
        meter.settle(r, sig);

        IMandateMeter.Receipt memory lower = receipt(id, 10 * CENT);
        bytes memory lowerSig = signReceipt(MANAGER_KEY, lower);
        vm.expectRevert(IMandateMeter.NothingToSettle.selector);
        meter.settle(lower, lowerSig);
        assertEq(usd.balanceOf(merchant), 50 * CENT);
    }

    function test_settle_acceptsThePayerAndTheManagerOnly() public {
        uint256 id = open(perCall());
        assertEq(settleAs(PAYER_KEY, id, 10 * CENT), 10 * CENT);
        assertEq(settleAs(MANAGER_KEY, id, 20 * CENT), 10 * CENT);

        IMandateMeter.Receipt memory r = receipt(id, 30 * CENT);
        bytes memory merchantSig = signReceipt(MERCHANT_KEY, r);
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.settle(r, merchantSig);

        bytes memory strangerSig = signReceipt(STRANGER_KEY, r);
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.settle(r, strangerSig);
    }

    function test_settle_withoutAManagerOnlyThePayerSigns() public {
        IMandateMeter.Terms memory t = perCall();
        t.manager = address(0);
        uint256 id = open(t);
        IMandateMeter.Receipt memory r = receipt(id, 10 * CENT);
        bytes memory managerSig = signReceipt(MANAGER_KEY, r);
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.settle(r, managerSig);
        assertEq(settleAs(PAYER_KEY, id, 10 * CENT), 10 * CENT);
    }

    function test_settle_aReceiptIsBoundToItsMeter() public {
        uint256 a = open(perCall());
        uint256 b = open(perCall());
        IMandateMeter.Receipt memory r = receipt(a, 10 * CENT);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        r.meterId = b;
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.settle(r, sig);
    }

    function test_settle_rejectsUnknownMetersAndFutureReceipts() public {
        IMandateMeter.Receipt memory r = receipt(99, 10 * CENT);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        vm.expectRevert(IMandateMeter.UnknownMeter.selector);
        meter.settle(r, sig);

        uint256 id = open(perCall());
        IMandateMeter.Receipt memory future = IMandateMeter.Receipt({meterId: id, total: 10 * CENT, issuedAt: T0 + 1});
        bytes memory futureSig = signReceipt(MANAGER_KEY, future);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.ReceiptFromTheFuture.selector, T0 + 1, T0));
        meter.settle(future, futureSig);
    }

    function test_settle_holdsThePeriodCapAndPaysTheRestNextPeriod() public {
        uint256 id = open(perCall());
        assertEq(settle(id, 7 * DOLLAR), 5 * DOLLAR);
        assertEq(meter.settleable(id, 7 * DOLLAR), 0);

        IMandateMeter.Receipt memory r = receipt(id, 7 * DOLLAR);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        vm.expectRevert(IMandateMeter.NothingToSettle.selector);
        meter.settle(r, sig);

        // A day later the same receipt pays what was held back.
        vm.warp(T0 + DAY);
        assertEq(meter.settleable(id, 7 * DOLLAR), 2 * DOLLAR);
        assertEq(meter.settle(r, sig), 2 * DOLLAR);
        assertEq(state(id).totalCharged, 7 * DOLLAR);
        assertEq(state(id).periodStart, T0 + DAY);
        assertEq(state(id).periodCharged, 2 * DOLLAR);
    }

    function test_settle_periodsStayAlignedAfterAGap() public {
        uint256 id = open(perCall());
        settle(id, 1 * DOLLAR);
        vm.warp(T0 + 3 * DAY + 5 hours);
        settle(id, 2 * DOLLAR);
        assertEq(state(id).periodStart, T0 + 3 * DAY);
    }

    function test_settle_neverPaysBeyondTheLifetimeCap() public {
        uint256 id = open(perCall());
        for (uint256 day = 0; day < 6; ++day) {
            vm.warp(T0 + day * DAY);
            uint96 total = uint96((day + 1) * 5 * DOLLAR);
            if (meter.settleable(id, total) > 0) settle(id, total);
        }
        assertEq(state(id).totalCharged, 20 * DOLLAR);
        assertEq(usd.balanceOf(merchant), 20 * DOLLAR);
        assertEq(meter.settleable(id, 1_000 * DOLLAR), 0);
    }

    function test_settle_reportsAShortfallWithoutReverting() public {
        uint256 id = open(perCall());
        address poor = vm.addr(0x9001);
        vm.prank(poor);
        usd.approve(address(meter), type(uint256).max);
        IMandateMeter.Terms memory t = perCall();
        vm.prank(poor);
        uint256 poorId = meter.createMeter(t);

        IMandateMeter.Receipt memory r = IMandateMeter.Receipt({meterId: poorId, total: 1 * DOLLAR, issuedAt: T0});
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        vm.expectEmit(address(meter));
        emit IMandateMeter.SettleFailed(poorId, METER_REASON_INSUFFICIENT_BALANCE, 1 * DOLLAR);
        assertEq(meter.settle(r, sig), 0);
        assertEq(uint8(state(poorId).status), uint8(IMandateMeter.Status.Delinquent));
        assertEq(state(poorId).totalCharged, 0);

        // Funded, the same receipt settles and the meter is active again.
        usd.mint(poor, 1 * DOLLAR);
        assertEq(meter.settle(r, sig), 1 * DOLLAR);
        assertEq(uint8(state(poorId).status), uint8(IMandateMeter.Status.Active));
        assertEq(state(id).totalCharged, 0);
    }

    function test_settle_reportsAMissingAllowance() public {
        uint256 id = open(perCall());
        vm.prank(payer);
        usd.approve(address(meter), 0);
        IMandateMeter.Receipt memory r = receipt(id, 1 * DOLLAR);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        vm.expectEmit(address(meter));
        emit IMandateMeter.SettleFailed(id, METER_REASON_INSUFFICIENT_ALLOWANCE, 1 * DOLLAR);
        assertEq(meter.settle(r, sig), 0);
    }

    function test_settle_revertsWhenTheTokenRefuses() public {
        IMandateMeter.Terms memory t = perCall();
        t.asset = address(refusing);
        uint256 id = open(t);
        refusing.setMode(RefusingToken.Mode.Revert);
        IMandateMeter.Receipt memory r = receipt(id, 1 * DOLLAR);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        vm.expectRevert();
        meter.settle(r, sig);
        assertEq(state(id).totalCharged, 0);
    }

    /*//////////////////////////////////////////////////////////////
                           EXPIRY AND CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function test_expiry_honorsReceiptsIssuedBeforeItOnly() public {
        uint256 id = open(perCall());
        uint64 expiresAt = state(id).expiresAt;

        vm.warp(expiresAt);
        IMandateMeter.Receipt memory before = receipt(id, 1 * DOLLAR);
        bytes memory beforeSig = signReceipt(MANAGER_KEY, before);

        vm.warp(expiresAt + 2 * DAY);
        assertEq(meter.settle(before, beforeSig), 1 * DOLLAR);

        IMandateMeter.Receipt memory later = receipt(id, 2 * DOLLAR);
        bytes memory laterSig = signReceipt(MANAGER_KEY, later);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.ReceiptTooLate.selector, expiresAt + 2 * DAY, expiresAt));
        meter.settle(later, laterSig);
    }

    function test_cancel_stopsNewUsageButNotDebtAlreadyOwed() public {
        uint256 id = open(perCall());
        IMandateMeter.Receipt memory owed = receipt(id, 2 * DOLLAR);
        bytes memory owedSig = signReceipt(MANAGER_KEY, owed);

        vm.warp(T0 + 60);
        vm.expectEmit(address(meter));
        emit IMandateMeter.MeterCancelled(id, payer);
        vm.prank(payer);
        meter.cancel(id);
        assertEq(state(id).closedAt, T0 + 60);
        assertEq(uint8(state(id).status), uint8(IMandateMeter.Status.Cancelled));

        assertEq(meter.settle(owed, owedSig), 2 * DOLLAR);

        vm.warp(T0 + 61);
        IMandateMeter.Receipt memory after_ = receipt(id, 3 * DOLLAR);
        bytes memory afterSig = signReceipt(MANAGER_KEY, after_);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.ReceiptTooLate.selector, T0 + 61, T0 + 60));
        meter.settle(after_, afterSig);
    }

    function test_cancel_byPayerManagerOrMerchantOnlyAndOnce() public {
        uint256 a = open(perCall());
        uint256 b = open(perCall());
        uint256 c = open(perCall());

        vm.prank(stranger);
        vm.expectRevert(IMandateMeter.NotAuthorized.selector);
        meter.cancel(a);

        vm.prank(manager);
        meter.cancel(a);
        vm.prank(merchant);
        meter.cancel(b);
        vm.prank(payer);
        meter.cancel(c);

        vm.prank(payer);
        vm.expectRevert(IMandateMeter.MeterIsCancelled.selector);
        meter.cancel(a);

        vm.expectRevert(IMandateMeter.UnknownMeter.selector);
        meter.cancel(99);
    }

    function test_cancelWithSig_byThePayerOrManager() public {
        uint256 a = open(perCall());
        uint256 b = open(perCall());
        uint256 deadline = T0 + 1 hours;

        meter.cancelWithSig(a, manager, 1, deadline, sign(MANAGER_KEY, meter.hashCancel(a, 1, deadline)));
        meter.cancelWithSig(b, payer, 1, deadline, sign(PAYER_KEY, meter.hashCancel(b, 1, deadline)));
        assertEq(uint8(state(a).status), uint8(IMandateMeter.Status.Cancelled));
        assertEq(uint8(state(b).status), uint8(IMandateMeter.Status.Cancelled));
    }

    function test_cancelWithSig_refusesTheMerchantStrangersAndReplays() public {
        uint256 id = open(perCall());
        uint256 deadline = T0 + 1 hours;

        bytes memory merchantSig = sign(MERCHANT_KEY, meter.hashCancel(id, 1, deadline));
        vm.expectRevert(IMandateMeter.NotAuthorized.selector);
        meter.cancelWithSig(id, merchant, 1, deadline, merchantSig);

        bytes memory forged = sign(STRANGER_KEY, meter.hashCancel(id, 1, deadline));
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.cancelWithSig(id, payer, 1, deadline, forged);

        bytes memory sig = sign(PAYER_KEY, meter.hashCancel(id, 2, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.SignatureExpired.selector, deadline, deadline + 1));
        meter.cancelWithSig(id, payer, 2, deadline, sig);
    }

    function test_invalidateNonce() public {
        vm.prank(payer);
        vm.expectEmit(address(meter));
        emit IMandateMeter.NonceInvalidated(payer, 5);
        meter.invalidateNonce(5);
        assertTrue(meter.nonceUsed(payer, 5));

        IMandateMeter.Terms memory t = perCall();
        bytes memory sig = sign(PAYER_KEY, meter.hashCreate(payer, t, 5, T0 + 1 hours));
        vm.expectRevert(abi.encodeWithSelector(IMandateMeter.NonceAlreadyUsed.selector, payer, 5));
        meter.createMeterWithSig(payer, t, 5, T0 + 1 hours, sig);
    }

    function test_settleable_isZeroForUnknownMeters() public view {
        assertEq(meter.settleable(42, 1 * DOLLAR), 0);
    }
}
