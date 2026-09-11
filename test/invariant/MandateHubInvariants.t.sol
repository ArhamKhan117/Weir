// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HubFixture} from "../helpers/HubFixture.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {MandateHubHandler, SkewedVault} from "./handlers/MandateHubHandler.sol";

/// @title MandateHubInvariants
/// @notice Stateful properties of the hub over arbitrary sequences of creations (direct and
///         signed, drawn from a wallet or from a vault, and with vaults that are not valid),
///         charges, cancels, pauses, resumes, manager changes (direct and signed), time, funding,
///         token refusals, and vault deposits, withdrawals, yield, losses, liquidity caps,
///         short and over payment, zero `max*` answers and share allowances, driven only through
///         `MandateHubHandler`:
///
///         - ids are unique, sequential from one, and `nextMandateId - 1` counts every creation
///         - the hub never holds any asset or any vault share
///         - every token movement is a mandate's pull, from its payer (or its vault, burning the
///           payer's shares) to its recorded merchant, and each mandate's receipts equal its
///           `totalCharged`
///         - no merchant ever receives other than exactly the booked amount from a vault
///         - a payer's vault position only ever shrinks by exactly the shares that paid merchants
///           what was booked, apart from the payer's own deposits and withdrawals and the vault's
///           yield and losses, and a vault's assets leave it only to pay those merchants
///         - `totalCharged <= maxTotal`; every charge is at most `maxPerCharge`, and a periodic one
///           is exactly `amount`
///         - terms, the vault included, never change; the manager changes only by the payer
///         - no debit after `expiresAt`, and none while paused but the pause's own settlement
///         - the schedule stays on its lattice and moves only by a debit or a resume, and two
///           periodic charges never share a period
///         - `Cancelled` is absorbing
///         - a failed charge moves nothing and leaves the schedule and total alone
///         - every charge and every pause or cancel settlement takes exactly what is due, or
///           reports exactly that amount as failed with the reason the specification gives
///         - a stream's total never exceeds its rate times the seconds it actually ran
///         - `isChargeable` implies a positive quote, and a funded chargeable mandate charges
///           exactly that quote right then
///         - every call's outcome matched the handler's model (no unexpected revert or success),
///           including `PaymentMismatch` from a vault paying short or over and `InvalidVault` for a
///           vault that is not one over the asset, each with its exact arguments
contract MandateHubInvariants is HubFixture {
    MandateHubHandler internal handler;

    /// @dev Carries the outcome of a probe charge out of the call that is always rolled back.
    error ProbeOutcome(bool succeeded, uint256 charged, bytes revertData);

    function setUp() public override {
        super.setUp();
        // The fixture deploys the hub under the EIP-712 domain "Weir", version "1".
        handler = new MandateHubHandler(hub, usd, ausd, refusing, "Weir", "1");

        bytes4[] memory selectors = new bytes4[](26);
        selectors[0] = MandateHubHandler.createPeriodic.selector;
        selectors[1] = MandateHubHandler.createStream.selector;
        selectors[2] = MandateHubHandler.signedCreate.selector;
        selectors[3] = MandateHubHandler.charge.selector;
        selectors[4] = MandateHubHandler.chargeDue.selector;
        selectors[5] = MandateHubHandler.cancel.selector;
        selectors[6] = MandateHubHandler.pause.selector;
        selectors[7] = MandateHubHandler.resume.selector;
        selectors[8] = MandateHubHandler.setManager.selector;
        selectors[9] = MandateHubHandler.signedAction.selector;
        selectors[10] = MandateHubHandler.signedSetManager.selector;
        selectors[11] = MandateHubHandler.warp.selector;
        selectors[12] = MandateHubHandler.warpToEdge.selector;
        selectors[13] = MandateHubHandler.setBalance.selector;
        selectors[14] = MandateHubHandler.setAllowance.selector;
        selectors[15] = MandateHubHandler.setRefusal.selector;
        selectors[16] = MandateHubHandler.deposit.selector;
        selectors[17] = MandateHubHandler.withdraw.selector;
        selectors[18] = MandateHubHandler.accrueYield.selector;
        selectors[19] = MandateHubHandler.setLiquidity.selector;
        selectors[20] = MandateHubHandler.setPaysShort.selector;
        selectors[21] = MandateHubHandler.setShareAllowance.selector;
        selectors[22] = MandateHubHandler.setPaysOver.selector;
        selectors[23] = MandateHubHandler.chargeAtVaultEdge.selector;
        selectors[24] = MandateHubHandler.pullForSettlement.selector;
        selectors[25] = MandateHubHandler.setZeroMax.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /*//////////////////////////////////////////////////////////////
                                   IDS
    //////////////////////////////////////////////////////////////*/

    function invariant_idsAreSequentialAndCounted() public view {
        uint256 n = handler.mandateCount();
        assertEq(hub.nextMandateId(), n + 1, "nextMandateId - 1 is the number created");
        for (uint256 i = 0; i < n; ++i) {
            assertEq(handler.createdId(i), i + 1, "ids are handed out once each, in order, from one");
            assertTrue(hub.getMandate(i + 1).payer != address(0), "every handed-out id exists");
        }
        assertEq(hub.getMandate(0).payer, address(0), "id zero is never a mandate");
        assertEq(hub.getMandate(n + 1).payer, address(0), "nothing exists past the last id");
    }

    /*//////////////////////////////////////////////////////////////
                                  FUNDS
    //////////////////////////////////////////////////////////////*/

    function invariant_hubHoldsNoFunds() public view {
        address[] memory assets = handler.assets();
        for (uint256 i = 0; i < assets.length; ++i) {
            assertEq(IERC20(assets[i]).balanceOf(address(hub)), 0, "the hub never holds an asset");
            assertEq(handler.vaults(i).balanceOf(address(hub)), 0, "the hub never holds a vault share");
        }
    }

    function invariant_fundsMoveOnlyFromPayerToMerchant() public view {
        assertEq(handler.strayTransfers(), 0, "a transfer other than a mandate's pull to its recorded merchant");
        assertEq(handler.conservationBreaches(), 0, "a balance moved other than by the booked debit");
        assertEq(handler.chargedEventMismatches(), 0, "a Charged event disagrees with what was booked");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            assertEq(
                handler.ghost(id).receipts,
                hub.getMandate(id).totalCharged,
                "a merchant's receipts from a mandate equal its totalCharged"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 VAULTS
    //////////////////////////////////////////////////////////////*/

    function invariant_vaultMerchantsReceiveExactlyTheBookedAmount() public view {
        assertEq(handler.vaultPaymentBreaches(), 0, "a merchant received other than the booked amount from a vault");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            MandateHubHandler.Ghost memory g = handler.ghost(id);
            if (g.created.vault == address(0)) continue;
            assertEq(g.receipts, hub.getMandate(id).totalCharged, "a vault paid a merchant other than its booked total");
        }
    }

    /// @dev The handler's ledger moves a position only by the payer's own deposits and
    ///      withdrawals and by the shares the vault priced each booked debit at, and a vault's
    ///      assets only by those, yield, losses, and the booked debits.
    function invariant_vaultPositionsShrinkOnlyByWhatWasPaid() public view {
        assertEq(handler.positionBreaches(), 0, "a hub call moved a vault position other than by the booked debit");

        for (uint256 v = 0; v < 3; ++v) {
            MockVault vault = handler.vaults(v);
            uint256 shares;
            for (uint256 i = 0; i < 3; ++i) {
                address payer = handler.payers(i);
                assertEq(vault.balanceOf(payer), handler.expectedShares(payer, v), "a position moved unaccounted");
                assertEq(_bookedFrom(payer, address(vault)), handler.paidFromVault(payer, v), "paid other than booked");
                shares += vault.balanceOf(payer);
            }
            assertEq(vault.totalSupply(), shares, "shares exist beyond the payers' positions");
            assertEq(
                IERC20(vault.asset()).balanceOf(address(vault)),
                handler.expectedVaultAssets(v),
                "a vault's assets moved unaccounted"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  CAPS
    //////////////////////////////////////////////////////////////*/

    function invariant_totalChargedWithinLifetimeCap() public view {
        assertEq(handler.totalDecreases(), 0, "a total went down");
        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            assertLe(m.totalCharged, m.maxTotal, "totalCharged <= maxTotal");
        }
    }

    function invariant_everyChargeWithinItsCaps() public view {
        assertEq(handler.capBreaches(), 0, "a charge broke a per-charge bound");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            MandateHubHandler.Ghost memory g = handler.ghost(id);
            IMandateHub.Mandate memory m = hub.getMandate(id);
            assertLe(g.maxDebit, m.maxPerCharge, "no single charge above maxPerCharge");
            if (m.period != 0) {
                assertEq(m.totalCharged, uint256(m.amount) * g.debits, "periodic totals are whole amounts");
                if (g.debits != 0) {
                    assertEq(g.minDebit, m.amount, "a periodic charge is exactly amount");
                    assertEq(g.maxDebit, m.amount, "a periodic charge is exactly amount");
                }
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  TERMS
    //////////////////////////////////////////////////////////////*/

    function invariant_termsNeverChange() public view {
        assertEq(handler.termMutations(), 0, "a call changed a term");
        assertEq(handler.creationMismatches(), 0, "a record was stored other than as agreed");
        assertEq(handler.foreignMutations(), 0, "a call changed a mandate it did not act on");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory c = handler.ghost(id).created;
            IMandateHub.Mandate memory m = hub.getMandate(id);
            assertEq(m.payer, c.payer, "payer");
            assertEq(m.merchant, c.merchant, "merchant");
            assertEq(m.asset, c.asset, "asset");
            assertEq(m.vault, c.vault, "vault");
            assertEq(m.amount, c.amount, "amount");
            assertEq(m.period, c.period, "period");
            assertEq(m.maxPerCharge, c.maxPerCharge, "maxPerCharge");
            assertEq(m.maxTotal, c.maxTotal, "maxTotal");
            assertEq(m.expiresAt, c.expiresAt, "expiresAt");
        }
    }

    function invariant_managerChangesOnlyByPayer() public view {
        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            assertEq(hub.getMandate(id).manager, handler.ghost(id).manager, "manager moved without the payer");
        }
    }

    /*//////////////////////////////////////////////////////////////
                               TIME AND STATE
    //////////////////////////////////////////////////////////////*/

    function invariant_scheduleMovesOnlyAsSpecified() public view {
        assertEq(handler.scheduleBreaches(), 0, "the schedule moved other than as specified");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            uint256 anchor = handler.ghost(id).created.nextChargeAt;
            assertGe(m.nextChargeAt, anchor, "the schedule never moves back past its start");
            if (m.period != 0) assertEq((m.nextChargeAt - anchor) % m.period, 0, "on the anchor's lattice");
        }
    }

    function invariant_noDebitAfterExpiry() public view {
        assertEq(handler.debitsAfterExpiry(), 0, "a debit after expiresAt");
        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            assertLe(handler.ghost(id).lastDebitAt, hub.getMandate(id).expiresAt, "last debit after expiresAt");
        }
    }

    function invariant_cancelledIsAbsorbing() public view {
        assertEq(handler.cancelledMutations(), 0, "a cancelled record changed");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            MandateHubHandler.Ghost memory g = handler.ghost(id);
            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (g.cancelled) {
                assertEq(uint8(m.status), uint8(IMandateHub.Status.Cancelled), "once cancelled, always cancelled");
                assertEq(m.totalCharged, g.totalAtCancel, "nothing charged after cancellation");
            } else {
                assertTrue(m.status != IMandateHub.Status.Cancelled, "cancelled without a successful cancel");
            }
        }
    }

    /// @dev A vault mandate paid from the balance says so, exactly once and for exactly the debit,
    ///      and nothing else ever does.
    function invariant_fallbackIsAnnouncedExactly() public view {
        assertEq(handler.fallbackEventMismatches(), 0, "ChargedFromBalance disagrees with what the balance paid");
    }

    function invariant_failedChargesMoveNothing() public view {
        assertEq(handler.failedChargeBreaches(), 0, "a ChargeFailed moved funds, booked, or moved the schedule");
    }

    /// @dev Charges, and the settlements inside pause and cancel, take exactly what the
    ///      specification says is due, or report exactly that amount as failed.
    function invariant_debitsAreExactlyWhatIsDue() public view {
        assertEq(handler.settlementBreaches(), 0, "a call debited other than exactly what was due");
    }

    function invariant_nothingDebitedWhilePaused() public view {
        assertEq(handler.debitsWhilePaused(), 0, "a debit while paused");

        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            assertEq(m.pausedAt, handler.ghost(id).pausedSince, "pause state as the handler saw it");
            if (m.period != 0) assertEq(m.pausedAt, 0, "a periodic mandate is never paused");
        }
    }

    /// @dev Up to the earlier of now and expiry, since nothing can be charged after expiry.
    function invariant_streamsNeverBillMoreThanRunningTime() public view {
        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (m.period != 0) continue;

            uint256 horizon = block.timestamp < m.expiresAt ? block.timestamp : m.expiresAt;
            assertLe(
                m.totalCharged,
                uint256(m.amount) * _runningSeconds(handler.ghost(id), horizon),
                "a stream billed more than rate times seconds run unpaused since its start"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                              CHARGEABILITY
    //////////////////////////////////////////////////////////////*/

    function invariant_chargeableMeansAFundedChargeSucceeds() public {
        for (uint256 id = 0; id <= handler.mandateCount() + 1; ++id) {
            uint256 quote = hub.quoteCharge(id);
            if (!hub.isChargeable(id)) {
                assertEq(quote, 0, "nothing quoted when not chargeable");
                continue;
            }
            assertGt(quote, 0, "chargeable implies a positive quote");

            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (!_funded(m, quote)) continue;

            (bool succeeded, uint256 charged, bytes memory revertData) = _probe(id);
            assertTrue(succeeded, string.concat("a funded chargeable charge reverted: ", vm.toString(revertData)));
            assertEq(charged, quote, "a funded chargeable charge takes exactly the quote");
        }
    }

    /// @dev Charges `id` and always reverts, carrying the outcome in `ProbeOutcome`, so the
    ///      invariant can observe a real charge without keeping it.
    function probeCharge(uint256 id) external {
        require(msg.sender == address(this), "probe only");
        uint96 before = hub.getMandate(id).totalCharged;
        try hub.charge(id) {
            revert ProbeOutcome(true, hub.getMandate(id).totalCharged - before, "");
        } catch (bytes memory err) {
            revert ProbeOutcome(false, 0, err);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 MODEL
    //////////////////////////////////////////////////////////////*/

    function invariant_everyOutcomeMatchedTheModel() public view {
        assertEq(
            handler.unexpectedReverts(), 0, string.concat("unexpected revert: ", vm.toString(handler.lastUnexpected()))
        );
        assertEq(
            handler.unexpectedSuccesses(),
            0,
            string.concat("unexpected success: ", vm.toString(handler.lastUnexpected()))
        );
    }

    function invariant_noncesMatchTheModel() public view {
        address[] memory signers = handler.signers();
        uint256 space = handler.NONCE_SPACE();
        for (uint256 i = 0; i < signers.length; ++i) {
            for (uint256 n = 0; n < space; ++n) {
                assertEq(hub.nonceUsed(signers[i], n), handler.nonceModel(signers[i], n), "nonce state");
            }
        }
    }

    /// @dev Printed with `-vv`, so a run can be checked for having reached the interesting paths.
    function afterInvariant() public view {
        console2.log("mandates", handler.mandateCount());
        console2.log("direct / signed creates", handler.directCreates(), handler.signedCreates());
        console2.log("debits / failed charges", handler.successfulDebits(), handler.chargeFailures());
        console2.log("cancels / pauses / resumes", handler.cancels(), handler.pauses(), handler.resumes());
        console2.log("manager changes direct / signed", handler.managerChanges(), handler.signedManagerChanges());
        console2.log("signed actions / legit reverts", handler.signedActions(), handler.legitReverts());
        console2.log("vault mandates / invalid vaults refused", handler.vaultMandates(), handler.invalidVaultRefusals());
        console2.log("vault debits / failures", handler.vaultDebits(), handler.vaultChargeFailures());
        console2.log("vault refusals / balance fallbacks", handler.refusedSettlements(), handler.balanceFallbacks());
        console2.log("deposits / withdrawals", handler.deposits(), handler.withdrawals());
        console2.log("yields / losses / edge probes", handler.yields(), handler.losses(), handler.edgeProbes());
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Seconds in `[start, horizon]` during which the stream was not paused.
    function _runningSeconds(MandateHubHandler.Ghost memory g, uint256 horizon) internal pure returns (uint256) {
        uint256 start = g.created.nextChargeAt;
        if (horizon <= start) return 0;

        uint256 paused = g.pausedOverlap;
        if (g.pausedSince != 0) {
            uint256 from = g.pausedSince > start ? g.pausedSince : start;
            if (horizon > from) paused += horizon - from;
        }
        // Paused intervals are disjoint and inside the window, so this cannot underflow unless the
        // ghost is wrong, and then zero makes the bound fail loudly.
        return paused > horizon - start ? 0 : horizon - start - paused;
    }

    /// @dev The payer can fund `amount` and the pull will complete: from a vault, when the
    ///      payer's shares and share allowance both cover its price, the vault has the liquidity
    ///      to pay it out, and it pays in full; otherwise, and for a direct mandate, from the
    ///      wallet, when balance and allowance cover it and the token accepts.
    function _funded(IMandateHub.Mandate memory m, uint256 amount) internal view returns (bool) {
        if (m.vault != address(0)) {
            SkewedVault vault = SkewedVault(m.vault);
            uint256 cost = vault.previewWithdraw(amount);
            bool vaultPays = !vault.paysShort() && !(vault.paysOver() && IERC20(m.asset).balanceOf(m.vault) > amount)
                && vault.balanceOf(m.payer) >= cost && vault.allowance(m.payer, address(hub)) >= cost
                && vault.liquidity() >= amount;
            if (vaultPays) return true;
        }
        if (m.asset == address(refusing) && refusing.mode() != RefusingToken.Mode.Normal) return false;
        IERC20 token = IERC20(m.asset);
        return token.balanceOf(m.payer) >= amount && token.allowance(m.payer, address(hub)) >= amount;
    }

    /// @dev What the mandates drawing from `vault` for `payer` have booked in total from it: their
    ///      totals less what the payer's balance paid when the vault could not.
    function _bookedFrom(address payer, address vault) internal view returns (uint256 total) {
        for (uint256 id = 1; id <= handler.mandateCount(); ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (m.payer == payer && m.vault == vault) total += m.totalCharged - handler.ghost(id).fromBalance;
        }
    }

    function _probe(uint256 id) internal returns (bool succeeded, uint256 charged, bytes memory revertData) {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.probeCharge, (id)));
        assertFalse(ok, "the probe always reverts");
        assertEq(bytes4(ret), ProbeOutcome.selector, "the probe reverts with its outcome");

        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i = 0; i < body.length; ++i) {
            body[i] = ret[i + 4];
        }
        return abi.decode(body, (bool, uint256, bytes));
    }
}
