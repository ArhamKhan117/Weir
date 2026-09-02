// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {MandateCharger} from "../../src/MandateCharger.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateChargerTest
/// @notice Batches charge everything chargeable, report each outcome, and never let one mandate
///         stop the rest; reports are accepted from the CRE forwarder alone.
contract MandateChargerTest is HubFixture {
    MandateCharger internal charger;
    address internal forwarder;
    address internal simulator;

    uint256 internal due;
    uint256 internal notDue;
    uint256 internal broke;

    function setUp() public override {
        super.setUp();
        forwarder = makeAddr("forwarder");
        simulator = makeAddr("simulation forwarder");
        charger = new MandateCharger(hub, forwarder, simulator);

        due = create(monthly());

        IMandateHub.Terms memory later = monthly();
        later.startAt = T0 + 1 days;
        notDue = create(later);

        address poor = makeAddr("poor payer");
        vm.prank(poor);
        broke = hub.createMandate(monthly());
    }

    function _ids() internal view returns (uint256[] memory ids) {
        ids = new uint256[](4);
        ids[0] = due;
        ids[1] = notDue;
        ids[2] = broke;
        ids[3] = 99;
    }

    function test_chargesWhatIsDueAndReportsTheRest() public {
        MandateCharger.Outcome[] memory outcomes = charger.chargeMany(_ids());

        assertEq(uint8(outcomes[0]), uint8(MandateCharger.Outcome.Charged));
        assertEq(uint8(outcomes[1]), uint8(MandateCharger.Outcome.Reverted));
        assertEq(uint8(outcomes[2]), uint8(MandateCharger.Outcome.Failed));
        assertEq(uint8(outcomes[3]), uint8(MandateCharger.Outcome.Reverted));

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(uint8(mandate(broke).status), uint8(IMandateHub.Status.Delinquent));
    }

    function test_emitsTheRevertSelector() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 99;

        vm.expectEmit(address(charger));
        emit MandateCharger.ChargeReverted(99, IMandateHub.UnknownMandate.selector);
        charger.chargeMany(ids);
    }

    function test_anyoneMayBatch() public {
        vm.prank(stranger);
        charger.chargeMany(_ids());
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_forwarderReportCharges() public {
        bytes memory metadata = abi.encodePacked(bytes32("workflow"), bytes10("keeper"), address(this), bytes2(0));

        vm.expectEmit(address(charger));
        emit MandateCharger.ReportCharged(bytes32("workflow"), forwarder, 4, 1);
        vm.prank(forwarder);
        charger.onReport(metadata, abi.encode(_ids()));

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_simulatorReportChargesAndIsNamedAsSuch() public {
        vm.expectEmit(address(charger));
        emit MandateCharger.ReportCharged(bytes32(0), simulator, 4, 1);
        vm.prank(simulator);
        charger.onReport("", abi.encode(_ids()));

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_reportFromAnyoneElseReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MandateCharger.NotForwarder.selector, stranger));
        charger.onReport("", abi.encode(_ids()));
    }

    function test_withoutAForwarderNoReportIsAccepted() public {
        MandateCharger local = new MandateCharger(hub, address(0), address(0));

        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(MandateCharger.NotForwarder.selector, address(0)));
        local.onReport("", abi.encode(_ids()));
    }

    function test_rejectsAZeroHub() public {
        vm.expectRevert(MandateCharger.InvalidHub.selector);
        new MandateCharger(IMandateHub(address(0)), forwarder, simulator);
    }

    function test_holdsNothing() public {
        charger.chargeMany(_ids());
        assertEq(usd.balanceOf(address(charger)), 0);
        assertEq(usd.balanceOf(address(hub)), 0);
    }

    function test_supportsReceiverInterfaces() public view {
        assertTrue(charger.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(charger.supportsInterface(type(IERC165).interfaceId));
        assertFalse(charger.supportsInterface(0xdeadbeef));
    }
}
