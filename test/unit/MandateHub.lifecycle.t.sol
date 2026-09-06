// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubLifecycleTest
/// @notice Who may stop, pause and manage a mandate. Either side can cancel; the payer and the
///         manager key can pause and resume a stream; only the payer can change the manager.
contract MandateHubLifecycleTest is HubFixture {
    uint256 internal periodicId;
    uint256 internal streamId;

    function setUp() public override {
        super.setUp();
        periodicId = create(monthly());
        streamId = create(perSecond());
    }

    /*//////////////////////////////////////////////////////////////
                                  CANCEL
    //////////////////////////////////////////////////////////////*/

    function _cancelBy(address who) internal {
        vm.expectEmit(address(hub));
        emit IMandateHub.MandateCancelled(periodicId, who);
        vm.prank(who);
        hub.cancelMandate(periodicId);
        assertEq(uint8(mandate(periodicId).status), uint8(IMandateHub.Status.Cancelled));
    }

    function test_payerCancels() public {
        _cancelBy(payer);
    }

    function test_merchantCancels() public {
        _cancelBy(merchant);
    }

    function test_managerCancels() public {
        _cancelBy(manager);
    }

    function test_strangerCannotCancel() public {
        vm.prank(stranger);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.cancelMandate(periodicId);
    }

    function test_withoutAManagerNobodyElseCancels() public {
        IMandateHub.Terms memory t = monthly();
        t.manager = address(0);
        uint256 id = create(t);

        vm.prank(address(0));
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.cancelMandate(id);
    }

    function test_cancelledIsAbsorbing() public {
        vm.prank(payer);
        hub.cancelMandate(periodicId);

        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        vm.prank(merchant);
        hub.cancelMandate(periodicId);

        assertFalse(hub.isChargeable(periodicId));
        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        hub.charge(periodicId);
    }

    function test_cancelUnknownReverts() public {
        vm.expectRevert(IMandateHub.UnknownMandate.selector);
        hub.cancelMandate(99);
    }

    function test_expiredMandateCanStillBeCancelled() public {
        vm.warp(mandate(periodicId).expiresAt + 1);
        vm.prank(payer);
        hub.cancelMandate(periodicId);
        assertEq(uint8(mandate(periodicId).status), uint8(IMandateHub.Status.Cancelled));
    }

    /*//////////////////////////////////////////////////////////////
                              PAUSE, RESUME
    //////////////////////////////////////////////////////////////*/

    function test_payerAndManagerPauseAndResume() public {
        vm.expectEmit(address(hub));
        emit IMandateHub.MandatePaused(streamId, payer);
        vm.prank(payer);
        hub.pauseMandate(streamId);

        vm.expectEmit(address(hub));
        emit IMandateHub.MandateResumed(streamId, manager);
        vm.prank(manager);
        hub.resumeMandate(streamId);
    }

    function test_merchantCannotPause() public {
        vm.prank(merchant);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.pauseMandate(streamId);
    }

    function test_merchantCannotResume() public {
        vm.prank(payer);
        hub.pauseMandate(streamId);

        vm.prank(merchant);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.resumeMandate(streamId);
    }

    function test_cannotPauseACancelledStream() public {
        vm.startPrank(payer);
        hub.cancelMandate(streamId);
        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        hub.pauseMandate(streamId);
        vm.stopPrank();
    }

    function test_cannotPauseAnExpiredStream() public {
        uint64 expiresAt = mandate(streamId).expiresAt;
        vm.warp(expiresAt + 1);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.MandateExpired.selector, expiresAt, expiresAt + 1));
        hub.pauseMandate(streamId);
    }

    /*//////////////////////////////////////////////////////////////
                                 MANAGER
    //////////////////////////////////////////////////////////////*/

    function test_payerReplacesTheManager() public {
        address next = makeAddr("next session key");

        vm.expectEmit(address(hub));
        emit IMandateHub.ManagerChanged(streamId, next);
        vm.prank(payer);
        hub.setManager(streamId, next);

        assertEq(mandate(streamId).manager, next);

        vm.prank(manager);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.pauseMandate(streamId);

        vm.prank(next);
        hub.pauseMandate(streamId);
    }

    function test_managerCannotReplaceItself() public {
        vm.prank(manager);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.setManager(streamId, manager);
    }

    function test_merchantCannotSetTheManager() public {
        vm.prank(merchant);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.setManager(streamId, merchant);
    }

    function test_managerCanBeRemoved() public {
        vm.prank(payer);
        hub.setManager(streamId, address(0));

        vm.prank(manager);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.cancelMandate(streamId);
    }

    function test_cannotSetTheManagerOnACancelledMandate() public {
        vm.startPrank(payer);
        hub.cancelMandate(streamId);
        vm.expectRevert(IMandateHub.MandateIsCancelled.selector);
        hub.setManager(streamId, stranger);
        vm.stopPrank();
    }

    function test_managerCannotMoveMoneyOrWidenAnything() public {
        IMandateHub.Mandate memory before = mandate(periodicId);

        vm.startPrank(manager);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.setManager(periodicId, manager);
        hub.cancelMandate(periodicId);
        vm.stopPrank();

        IMandateHub.Mandate memory afterwards = mandate(periodicId);
        assertEq(afterwards.merchant, before.merchant);
        assertEq(afterwards.amount, before.amount);
        assertEq(afterwards.maxTotal, before.maxTotal);
        assertEq(afterwards.expiresAt, before.expiresAt);
        assertEq(usd.balanceOf(merchant), 0);
    }
}
