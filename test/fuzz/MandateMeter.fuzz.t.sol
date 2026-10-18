// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {MeterFixture} from "../helpers/MeterFixture.sol";
import {IMandateMeter} from "../../src/interfaces/IMandateMeter.sol";

contract MandateMeterFuzzTest is MeterFixture {
    /// @notice One settlement pays exactly min(owed, period cap left, lifetime cap left), and
    ///         `settleable` predicts it.
    function testFuzz_settle_paysExactlyWhatTheCapsAllow(uint96 first, uint96 second, uint32 gap) public {
        uint256 id = open(perCall());
        first = uint96(bound(first, 1, 30 * DOLLAR));
        second = uint96(bound(second, 0, 60 * DOLLAR));
        gap = uint32(bound(gap, 0, 40 days));

        uint256 predicted = meter.settleable(id, first);
        uint256 paid = settle(id, first);
        assertEq(paid, predicted);
        assertEq(paid, first < 5 * DOLLAR ? first : 5 * DOLLAR);

        vm.warp(T0 + gap);
        uint256 total = uint256(first > second ? first : second);
        uint256 charged = state(id).totalCharged;
        uint256 owed = total > charged ? total - charged : 0;
        uint256 periodLeft = gap >= DAY ? 5 * DOLLAR : 5 * DOLLAR - paid;
        uint256 expected = owed;
        if (expected > periodLeft) expected = periodLeft;
        if (expected > 20 * DOLLAR - charged) expected = 20 * DOLLAR - charged;

        bool late = uint256(T0) + gap > state(id).expiresAt;
        assertEq(meter.settleable(id, uint96(total)), expected);
        if (expected == 0 || late) return;
        assertEq(settle(id, uint96(total)), expected);
        assertEq(usd.balanceOf(merchant), charged + expected);
    }

    /// @notice A signature over one total never settles any other total.
    function testFuzz_settle_aSignatureCoversOneTotalOnly(uint96 signed, uint96 claimed) public {
        signed = uint96(bound(signed, 1, 5 * DOLLAR));
        claimed = uint96(bound(claimed, 1, 5 * DOLLAR));
        vm.assume(signed != claimed);
        uint256 id = open(perCall());

        IMandateMeter.Receipt memory r = receipt(id, signed);
        bytes memory sig = signReceipt(MANAGER_KEY, r);
        r.total = claimed;
        vm.expectRevert(IMandateMeter.InvalidSignature.selector);
        meter.settle(r, sig);
    }

    /// @notice Settled in any number of steps, the merchant ends with the highest total signed,
    ///         given enough periods to clear the cap.
    function testFuzz_settle_stepsAddUpToTheHighestTotal(uint96[8] memory totals) public {
        uint256 id = open(perCall());
        uint96 highest;
        for (uint256 i = 0; i < totals.length; ++i) {
            uint96 t = uint96(bound(totals[i], 0, 20 * DOLLAR));
            if (t > highest) highest = t;
            vm.warp(T0 + i * DAY);
            if (meter.settleable(id, t) > 0) settle(id, t);
        }
        // Drain whatever the daily cap held back, a day at a time.
        for (uint256 d = 0; d < 5 && state(id).totalCharged < highest; ++d) {
            vm.warp(T0 + (totals.length + d) * DAY);
            settle(id, highest);
        }
        assertEq(state(id).totalCharged, highest);
        assertEq(usd.balanceOf(merchant), highest);
    }
}
