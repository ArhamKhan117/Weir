// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MandateMeter} from "../../src/MandateMeter.sol";
import {IMandateMeter} from "../../src/interfaces/IMandateMeter.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {MandateMeterHandler} from "./handlers/MandateMeterHandler.sol";

/// @title MandateMeterInvariants
/// @notice Whatever order receipts, settlements, cancellations and funding gaps come in, a meter
///         pays merchants exactly what it books, never more than the payer signed for, and never
///         more than its caps allow in any period or in all.
contract MandateMeterInvariants is Test {
    MandateMeter internal meter;
    TestStablecoin internal usd;
    MandateMeterHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new TestStablecoin("Test Dollar", "TUSD");
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        meter = new MandateMeter("Weir", "1", assets);
        handler = new MandateMeterHandler(meter, usd);
        targetContract(address(handler));
    }

    function invariant_merchantsReceiveExactlyWhatIsBooked() public view {
        for (uint256 i = 0; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            assertEq(usd.balanceOf(handler.merchantOf(id)), meter.getMeter(id).totalCharged);
        }
    }

    function invariant_neverMoreThanSignedOrTheLifetimeCap() public view {
        for (uint256 i = 0; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            IMandateMeter.Meter memory m = meter.getMeter(id);
            assertLe(m.totalCharged, m.maxTotal);
            assertLe(m.totalCharged, handler.highestSigned(id));
        }
    }

    function invariant_neverMoreThanThePeriodCapInAnyPeriod() public view {
        for (uint256 i = 0; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            IMandateMeter.Meter memory m = meter.getMeter(id);
            assertLe(m.periodCharged, m.periodCap);
            uint64[] memory periods = handler.periodsOf(id);
            for (uint256 p = 0; p < periods.length; ++p) {
                assertLe(handler.paidInPeriod(id, periods[p]), m.periodCap);
            }
        }
    }

    function invariant_theMeterNeverHoldsMoney() public view {
        assertEq(usd.balanceOf(address(meter)), 0);
    }

    /// @notice The run actually exercised settlement, so the invariants above are not vacuous.
    function afterInvariant() external view {
        assertGt(handler.settlements() + handler.shortfalls(), 0);
    }

    function invariant_periodsStartOnBoundaries() public view {
        for (uint256 i = 0; i < handler.idCount(); ++i) {
            IMandateMeter.Meter memory m = meter.getMeter(handler.ids(i));
            assertEq((m.periodStart - 1_800_000_000) % m.period, 0);
        }
    }
}
