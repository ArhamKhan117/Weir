// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {MandateCharger} from "../../src/MandateCharger.sol";
import {HungryVault} from "../mocks/HungryVault.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubGasTest
/// @notice No gas limit can turn work into a failure. A call that runs out of gas inside a charge,
///         a settlement or a batch reverts the whole call with `InsufficientGas` instead of being
///         caught and carried on from: a starved vault withdrawal never falls back to the balance,
///         a starved settlement never lets a stop skip what a stream owes, and a starved charge
///         never shows in a batch as a reverted charge. That is also what makes a gas estimate,
///         the lowest limit that does not revert, cover the work every time.
/// @dev The vault burns more gas than sixty-three sixty-fourths of `TIGHT` leaves it, while the
///      sixty-fourth kept back would still pay for a fallback transfer: without the guard, these
///      starved calls would succeed the wrong way. At `AMPLE` the same calls succeed the right way.
contract MandateHubGasTest is HubFixture {
    uint256 internal constant APPETITE = 6_000_000;
    uint256 internal constant TIGHT = 5_000_000;
    uint256 internal constant AMPLE = 10_000_000;

    HungryVault internal vault;
    MandateCharger internal charger;

    function setUp() public override {
        super.setUp();
        vault = new HungryVault(usd, APPETITE);
        charger = new MandateCharger(hub, makeAddr("forwarder"), makeAddr("simulation forwarder"));

        // Savings to draw from, and the backup on the balance that a fallback would use.
        vm.startPrank(payer);
        usd.approve(address(vault), 500 * uint256(DOLLAR));
        vault.deposit(500 * uint256(DOLLAR), payer);
        vault.approve(address(hub), type(uint256).max);
        usd.approve(address(hub), type(uint256).max);
        vm.stopPrank();
    }

    function _fromSavings(IMandateHub.Terms memory t) internal view returns (IMandateHub.Terms memory) {
        t.vault = address(vault);
        return t;
    }

    function test_aStarvedVaultWithdrawalRevertsTheChargeRatherThanFallBack() public {
        uint256 id = create(_fromSavings(monthly()));
        uint256 wallet = usd.balanceOf(payer);

        vm.expectRevert(IMandateHub.InsufficientGas.selector);
        hub.charge{gas: TIGHT}(id);
        assertEq(usd.balanceOf(payer), wallet, "the balance paid for a starved withdrawal");

        uint256 shares = vault.balanceOf(payer);
        hub.charge{gas: AMPLE}(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(payer), wallet, "with gas enough the vault pays, not the balance");
        assertLt(vault.balanceOf(payer), shares);
    }

    function test_aStarvedChargeRevertsTheBatchRatherThanBeRecordedAsReverted() public {
        uint256 id = create(_fromSavings(monthly()));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.expectRevert(IMandateHub.InsufficientGas.selector);
        charger.chargeMany{gas: TIGHT}(ids);

        MandateCharger.Outcome[] memory outcomes = charger.chargeMany{gas: AMPLE}(ids);
        assertEq(uint8(outcomes[0]), uint8(MandateCharger.Outcome.Charged));
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_aStarvedSettlementRevertsTheStopRatherThanSkipWhatIsOwed() public {
        uint256 id = create(_fromSavings(perSecond()));
        vm.warp(T0 + 60);

        vm.prank(payer);
        vm.expectRevert(IMandateHub.InsufficientGas.selector);
        hub.pauseMandate{gas: TIGHT}(id);
        assertEq(mandate(id).pausedAt, 0, "the stream paused without settling");

        vm.prank(payer);
        hub.pauseMandate{gas: AMPLE}(id);
        assertEq(mandate(id).pausedAt, T0 + 60);
        assertEq(mandate(id).totalCharged, 100 * 60, "the settlement collected the minute");
        assertEq(usd.balanceOf(merchant), 100 * 60);
    }

    /// @dev A refusal on its own merits, with gas to spare, is still caught: here the vault cannot
    ///      be drawn on at all, and the balance pays.
    function test_aRefusalThatIsNotStarvationStillFallsBack() public {
        uint256 id = create(_fromSavings(monthly()));
        vm.prank(payer);
        vault.approve(address(hub), 0);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargedFromBalance(id, 10 * DOLLAR);
        hub.charge{gas: AMPLE}(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }
}
