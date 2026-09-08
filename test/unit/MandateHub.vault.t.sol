// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {
    IMandateHub,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE,
    REASON_TRANSFER_REFUSED
} from "../../src/interfaces/IMandateHub.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {MisquotingVault} from "../mocks/MisquotingVault.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubVaultTest
/// @notice Earning until charged: a mandate drawn from an ERC-4626 vault withdraws exactly what is
///         due, straight to the merchant, and leaves the rest of the savings earning. When the
///         vault cannot pay, for want of shares, share allowance or liquidity, or because it pays
///         the wrong amount or cannot answer at all, the same amount comes from the payer's
///         balance of the asset, the backup they allowed. With no backup the charge reports the
///         vault's reason and moves nothing, and nothing ever blocks a pause or cancel.
/// @dev The payer here starts with no backup: their asset allowance to the hub is zero, so every
///      case shows the vault's own behaviour unless a test grants one.
/// @dev Runs against a vault that reports its limits honestly; `MandateHubZeroMaxVaultTest` below
///      runs every case again against one that answers zero from every `max*` view.
contract MandateHubVaultTest is HubFixture {
    MockVault internal vault;
    uint256 internal constant SAVED = 500 * uint256(DOLLAR);

    function setUp() public virtual override {
        super.setUp();
        vault = new MockVault(usd);

        vm.startPrank(payer);
        usd.approve(address(vault), SAVED);
        vault.deposit(SAVED, payer);
        vault.approve(address(hub), type(uint256).max);
        usd.approve(address(hub), 0);
        vm.stopPrank();
    }

    function _fromSavings(IMandateHub.Terms memory t) internal view returns (IMandateHub.Terms memory) {
        t.vault = address(vault);
        return t;
    }

    /// @dev What the payer's savings are worth, read the way that works for any vault.
    function _saved() internal view returns (uint256) {
        return vault.previewRedeem(vault.balanceOf(payer));
    }

    function test_storesAndEmitsTheVault() public {
        IMandateHub.Terms memory t = _fromSavings(monthly());

        vm.expectEmit(address(hub));
        emit IMandateHub.MandateCreated(
            1,
            payer,
            merchant,
            address(usd),
            address(vault),
            manager,
            t.amount,
            t.period,
            T0,
            t.maxPerCharge,
            t.maxTotal,
            t.expiresAt,
            t.ref
        );
        uint256 id = create(t);
        assertEq(mandate(id).vault, address(vault));
    }

    function test_chargeWithdrawsExactlyTheAmountToTheMerchant() public {
        uint256 id = create(_fromSavings(monthly()));
        uint256 walletBefore = usd.balanceOf(payer);
        uint256 savedBefore = _saved();
        uint256 sharesBefore = vault.balanceOf(payer);
        uint256 cost = vault.previewWithdraw(10 * DOLLAR);

        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(payer), walletBefore);
        assertEq(_saved(), savedBefore - 10 * DOLLAR);
        assertEq(vault.balanceOf(payer), sharesBefore - cost);
        assertEq(usd.balanceOf(address(hub)), 0);
        assertEq(vault.balanceOf(address(hub)), 0);
    }

    function test_theRestKeepsEarning() public {
        uint256 id = create(_fromSavings(monthly()));
        hub.charge(id);

        // A month of yield lands in the vault: every remaining share is worth more.
        usd.mint(address(vault), 49 * DOLLAR);
        vm.warp(T0 + MONTH);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 20 * DOLLAR);
        assertApproxEqAbs(_saved(), SAVED - 20 * DOLLAR + 49 * DOLLAR, 2);
    }

    function test_streamsFromSavings() public {
        uint256 id = create(_fromSavings(perSecond()));
        vm.warp(T0 + 1 hours);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 100 * 1 hours);
    }

    /*//////////////////////////////////////////////////////////////
                             FUNDING LINES
    //////////////////////////////////////////////////////////////*/

    function test_shortSavingsFailWithoutReverting() public {
        IMandateHub.Terms memory t = _fromSavings(monthly());
        t.amount = 600 * DOLLAR;
        t.maxPerCharge = t.amount;
        t.maxTotal = t.amount;
        uint256 id = create(t);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, 600 * DOLLAR);
        hub.charge(id);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
    }

    /// @dev The line is the payer's shares against what the vault would burn: every share of the
    ///      savings pays, and one base unit more is reason 1 with nothing moved.
    function test_theShareBalanceIsTheFundingLine() public {
        IMandateHub.Terms memory t = _fromSavings(monthly());
        t.amount = uint96(SAVED + 1);
        t.maxPerCharge = t.amount;
        t.maxTotal = t.amount;
        uint256 over = create(t);
        assertGt(vault.previewWithdraw(SAVED + 1), vault.balanceOf(payer));

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(over, REASON_INSUFFICIENT_BALANCE, SAVED + 1);
        hub.charge(over);
        assertEq(vault.balanceOf(payer), SAVED);

        t.amount = uint96(SAVED);
        t.maxPerCharge = t.amount;
        t.maxTotal = t.amount;
        uint256 exact = create(t);
        assertEq(vault.previewWithdraw(SAVED), vault.balanceOf(payer));

        hub.charge(exact);
        assertEq(usd.balanceOf(merchant), SAVED);
        assertEq(vault.balanceOf(payer), 0);
    }

    function test_missingShareAllowanceFailsWithoutReverting() public {
        uint256 id = create(_fromSavings(monthly()));
        vm.prank(payer);
        vault.approve(address(hub), 0);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_ALLOWANCE, 10 * DOLLAR);
        hub.charge(id);
    }

    function test_aShareAllowanceOneShareShortFailsWithoutReverting() public {
        uint256 id = create(_fromSavings(monthly()));
        usd.mint(address(vault), 37 * DOLLAR);
        uint256 cost = vault.previewWithdraw(10 * DOLLAR);
        vm.prank(payer);
        vault.approve(address(hub), cost - 1);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_ALLOWANCE, 10 * DOLLAR);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 0);

        vm.prank(payer);
        vault.approve(address(hub), cost);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(vault.allowance(payer, address(hub)), 0);
    }

    /// @dev The asset allowance is the backup: with no share allowance the balance pays, the
    ///      shares stay where they are, and the charge says so.
    function test_anAssetAllowanceIsTheBackupForAShareAllowance() public {
        uint256 id = create(_fromSavings(monthly()));
        vm.startPrank(payer);
        vault.approve(address(hub), 0);
        usd.approve(address(hub), type(uint256).max);
        vm.stopPrank();
        uint256 walletBefore = usd.balanceOf(payer);
        uint256 sharesBefore = vault.balanceOf(payer);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargedFromBalance(id, 10 * DOLLAR);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(payer), walletBefore - 10 * DOLLAR);
        assertEq(vault.balanceOf(payer), sharesBefore);
        assertEq(mandate(id).totalCharged, 10 * DOLLAR);
    }

    /// @dev Short of savings and of a backup, the reason is the vault's: the shares.
    function test_withNeitherSourceTheReasonIsTheVaults() public {
        IMandateHub.Terms memory t = _fromSavings(monthly());
        t.amount = 600 * DOLLAR;
        t.maxPerCharge = t.amount;
        t.maxTotal = t.amount;
        uint256 id = create(t);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
        deal(address(usd), payer, 599 * uint256(DOLLAR));

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_INSUFFICIENT_BALANCE, 600 * DOLLAR);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          A VAULT THAT CANNOT PAY
    //////////////////////////////////////////////////////////////*/

    /// @dev Liquidity is the vault's to enforce, and the hub does not ask for it: the withdrawal
    ///      itself refuses. With no backup the charge reports reason 3, moves and books nothing,
    ///      and the same charge goes through once the vault can pay.
    function test_anIlliquidVaultWithNoBackupFailsCleanly() public {
        uint256 id = create(_fromSavings(monthly()));
        vault.setLiquidity(10 * DOLLAR - 1);
        uint256 sharesBefore = vault.balanceOf(payer);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 10 * DOLLAR);
        hub.charge(id);
        assertEq(mandate(id).totalCharged, 0);
        assertEq(mandate(id).nextChargeAt, T0);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
        assertEq(vault.balanceOf(payer), sharesBefore);
        assertEq(usd.balanceOf(merchant), 0);

        vault.setLiquidity(type(uint256).max);
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Active));
    }

    /// @dev The case the fallback is for: savings that cannot be withdrawn right now, and the
    ///      money in the payer's balance. The merchant is paid on time, from the balance, and the
    ///      savings stay put.
    function test_anIlliquidVaultFallsBackToTheBalance() public {
        uint256 id = create(_fromSavings(monthly()));
        vault.setLiquidity(0);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
        uint256 walletBefore = usd.balanceOf(payer);
        uint256 sharesBefore = vault.balanceOf(payer);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargedFromBalance(id, 10 * DOLLAR);
        vm.expectEmit(address(hub));
        emit IMandateHub.Charged(id, merchant, 10 * DOLLAR, uint96(10 * DOLLAR), T0 + MONTH);
        hub.charge(id);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(payer), walletBefore - 10 * DOLLAR);
        assertEq(vault.balanceOf(payer), sharesBefore);
        assertEq(usd.balanceOf(address(hub)), 0);

        // Next month the vault can pay again, and savings pay.
        vault.setLiquidity(type(uint256).max);
        vm.warp(T0 + MONTH);
        hub.charge(id);
        assertEq(usd.balanceOf(payer), walletBefore - 10 * DOLLAR);
        assertLt(vault.balanceOf(payer), sharesBefore);
    }

    /// @dev The fallback is bounded by the same limits as the vault: the cap on the total stops
    ///      it as it stops any charge.
    function test_theFallbackKeepsToTheCaps() public {
        IMandateHub.Terms memory t = _fromSavings(monthly());
        t.maxTotal = t.amount;
        uint256 id = create(t);
        vault.setLiquidity(0);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);

        hub.charge(id);
        vm.warp(T0 + MONTH);
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, t.amount, t.maxTotal));
        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_pauseGoesAheadWhenTheVaultIsIlliquid() public {
        uint256 id = create(_fromSavings(perSecond()));
        vault.setLiquidity(0);
        uint256 savedBefore = vault.balanceOf(payer);

        vm.warp(T0 + 60);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 100 * 60);
        vm.prank(payer);
        hub.pauseMandate(id);

        assertEq(mandate(id).pausedAt, T0 + 60);
        assertEq(mandate(id).totalCharged, 0);
        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Delinquent));
        assertEq(usd.balanceOf(merchant), 0);
        assertEq(vault.balanceOf(payer), savedBefore);
    }

    function test_aVaultThatPaysShortCannotShortPayTheMerchant() public {
        uint256 id = create(_fromSavings(monthly()));
        vault.setPaysShort(true);
        uint256 sharesBefore = vault.balanceOf(payer);

        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 10 * DOLLAR);
        hub.charge(id);
        assertEq(mandate(id).totalCharged, 0);
        assertEq(usd.balanceOf(merchant), 0);
        assertEq(vault.balanceOf(payer), sharesBefore);
    }

    /// @dev The receipt check undoes the short withdrawal whole, and the balance pays in full.
    function test_aVaultThatPaysShortFallsBackToTheBalanceInFull() public {
        uint256 id = create(_fromSavings(monthly()));
        vault.setPaysShort(true);
        vm.prank(payer);
        usd.approve(address(hub), type(uint256).max);
        uint256 sharesBefore = vault.balanceOf(payer);

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(vault.balanceOf(payer), sharesBefore);
    }

    function test_pauseGoesAheadWhenTheVaultPaysShort() public {
        uint256 id = create(_fromSavings(perSecond()));
        vault.setPaysShort(true);
        uint256 savedBefore = vault.balanceOf(payer);

        vm.warp(T0 + 60);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 100 * 60);
        vm.prank(payer);
        hub.pauseMandate(id);

        assertEq(mandate(id).pausedAt, T0 + 60);
        assertEq(mandate(id).totalCharged, 0);
        assertEq(usd.balanceOf(merchant), 0);
        assertEq(vault.balanceOf(payer), savedBefore);
    }

    /*//////////////////////////////////////////////////////////////
                        A VAULT THAT CANNOT ANSWER
    //////////////////////////////////////////////////////////////*/

    /// @dev A vault whose `previewWithdraw` or share `balanceOf` reverts, or returns nothing a
    ///      typed call can decode: with no backup the charge reports reason 3 with nothing moved,
    ///      and once it answers again the same charge goes through.
    function test_aVaultThatCannotQuoteFailsCleanlyAndMovesNothing() public {
        _chargeAgainstAFault(MisquotingVault.Fault.Reverts, MisquotingVault.Fault.None);
        _chargeAgainstAFault(MisquotingVault.Fault.AnswersNothing, MisquotingVault.Fault.None);
        _chargeAgainstAFault(MisquotingVault.Fault.None, MisquotingVault.Fault.Reverts);
        _chargeAgainstAFault(MisquotingVault.Fault.None, MisquotingVault.Fault.AnswersNothing);
    }

    /// @dev The same faults never block a stop: the settlement reports reason 3 and the pause or
    ///      cancel goes ahead with nothing moved.
    function test_aVaultThatCannotQuoteNeverBlocksAStop() public {
        _stopAgainstAFault(MisquotingVault.Fault.Reverts, MisquotingVault.Fault.None, false);
        _stopAgainstAFault(MisquotingVault.Fault.AnswersNothing, MisquotingVault.Fault.None, true);
        _stopAgainstAFault(MisquotingVault.Fault.None, MisquotingVault.Fault.Reverts, true);
        _stopAgainstAFault(MisquotingVault.Fault.None, MisquotingVault.Fault.AnswersNothing, false);
    }

    function _chargeAgainstAFault(MisquotingVault.Fault preview, MisquotingVault.Fault balance) internal {
        MisquotingVault faulty = _misquotingSavings();
        IMandateHub.Terms memory t = monthly();
        t.vault = address(faulty);
        uint256 id = create(t);
        uint256 paid = usd.balanceOf(merchant);
        uint256 shares = faulty.balanceOf(payer);

        faulty.setFaults(preview, balance);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 10 * DOLLAR);
        hub.charge(id);
        faulty.setFaults(MisquotingVault.Fault.None, MisquotingVault.Fault.None);

        assertEq(mandate(id).totalCharged, 0, "nothing booked");
        assertEq(faulty.balanceOf(payer), shares, "shares moved");
        assertEq(usd.balanceOf(merchant), paid, "the merchant was paid");

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), paid + 10 * DOLLAR, "the same charge once the vault answers");
    }

    function _stopAgainstAFault(MisquotingVault.Fault preview, MisquotingVault.Fault balance, bool cancelling)
        internal
    {
        MisquotingVault faulty = _misquotingSavings();
        IMandateHub.Terms memory t = perSecond();
        t.vault = address(faulty);
        uint256 id = create(t);
        vm.warp(block.timestamp + 60);
        uint256 paid = usd.balanceOf(merchant);
        uint256 shares = faulty.balanceOf(payer);

        faulty.setFaults(preview, balance);
        vm.expectEmit(address(hub));
        emit IMandateHub.ChargeFailed(id, REASON_TRANSFER_REFUSED, 100 * 60);
        vm.prank(payer);
        if (cancelling) hub.cancelMandate(id);
        else hub.pauseMandate(id);
        faulty.setFaults(MisquotingVault.Fault.None, MisquotingVault.Fault.None);

        IMandateHub.Mandate memory m = mandate(id);
        if (cancelling) assertEq(uint8(m.status), uint8(IMandateHub.Status.Cancelled), "the cancel went ahead");
        else assertEq(m.pausedAt, block.timestamp, "the pause went ahead");
        assertEq(m.totalCharged, 0, "nothing booked");
        assertEq(faulty.balanceOf(payer), shares, "shares moved");
        assertEq(usd.balanceOf(merchant), paid, "the merchant was paid");
    }

    /// @dev A fresh misquoting vault in this suite's `max*` mode, holding a hundred dollars of the
    ///      payer's savings with an unlimited share allowance to the hub.
    function _misquotingSavings() internal returns (MisquotingVault faulty) {
        faulty = new MisquotingVault(usd);
        faulty.setZeroMax(vault.zeroMax());
        usd.mint(payer, 100 * DOLLAR);
        vm.startPrank(payer);
        usd.approve(address(faulty), 100 * DOLLAR);
        faulty.deposit(100 * DOLLAR, payer);
        faulty.approve(address(hub), type(uint256).max);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function test_cancelSettlesFromSavings() public {
        uint256 id = create(_fromSavings(perSecond()));
        vm.warp(T0 + 300);
        vm.prank(payer);
        hub.cancelMandate(id);

        assertEq(usd.balanceOf(merchant), 100 * 300);
    }

    function test_settlementPullIsForTheHubAlone() public {
        uint256 id = create(_fromSavings(perSecond()));
        vm.warp(T0 + 60);

        vm.prank(stranger);
        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.pullForSettlement(id, 1);
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _expectInvalidVault(address candidate) internal {
        IMandateHub.Terms memory t = monthly();
        t.vault = candidate;

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.InvalidVault.selector, candidate));
        vm.prank(payer);
        hub.createMandate(t);
    }

    function test_refusesAVaultOverAnotherAsset() public {
        _expectInvalidVault(address(new MockVault(ausd)));
    }

    function test_refusesAnAddressWithNoCode() public {
        _expectInvalidVault(makeAddr("not a vault"));
    }

    function test_refusesAContractThatIsNotAVault() public {
        _expectInvalidVault(address(ausd));
    }
}

/// @title MandateHubZeroMaxVaultTest
/// @notice Every case above, against a vault shaped like Morpho Vault V2, the kind Weir draws from
///         on Mainnet: `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` answer zero for
///         everyone, a real holder included, while previews, deposits and withdrawals work. The
///         hub never reads those views, so every charge goes through as it does against a vault
///         that reports its limits, and liquidity shows only as the withdrawal's own revert.
contract MandateHubZeroMaxVaultTest is MandateHubVaultTest {
    function setUp() public override {
        super.setUp();
        vault.setZeroMax(true);
    }

    function test_theVaultReportsNoRoomAtAll() public view {
        assertEq(vault.balanceOf(payer), SAVED);
        assertEq(vault.maxDeposit(payer), 0);
        assertEq(vault.maxMint(payer), 0);
        assertEq(vault.maxWithdraw(payer), 0);
        assertEq(vault.maxRedeem(payer), 0);
    }

    /// @dev Both modes, and the settlement inside a pause, all charge in full although the vault
    ///      says the payer can withdraw nothing.
    function test_chargesInFullAlthoughTheVaultReportsNoRoom() public {
        uint256 periodic = create(_fromSavings(monthly()));
        uint256 stream = create(_fromSavings(perSecond()));
        vm.warp(T0 + 1 hours);

        hub.charge(periodic);
        hub.charge(stream);
        vm.warp(T0 + 2 hours);
        vm.prank(payer);
        hub.pauseMandate(stream);

        assertEq(usd.balanceOf(merchant), 10 * DOLLAR + 100 * 2 hours);
        assertEq(mandate(periodic).totalCharged, 10 * DOLLAR);
        assertEq(mandate(stream).totalCharged, 100 * 2 hours);
        assertEq(uint8(mandate(periodic).status), uint8(IMandateHub.Status.Active));
        assertEq(uint8(mandate(stream).status), uint8(IMandateHub.Status.Active));
        assertEq(vault.maxWithdraw(payer), 0);
    }
}
