// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SavingsRouter} from "../../src/SavingsRouter.sol";
import {ISavingsRouter} from "../../src/interfaces/ISavingsRouter.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";
import {ReentrantVault} from "../mocks/ReentrantVault.sol";
import {ShortPullVault} from "../mocks/ShortPullVault.sol";
import {RouterFixture} from "../helpers/RouterFixture.sol";

/// @title SavingsRouterTest
/// @notice Gasless savings: a payer who holds no gas token signs a permit, anyone submits it, and
///         the payer's dollars land in the one vault fixed for the asset, in the payer's own name.
///         Whoever submits can decide whether and when, never where: shares and assets always go
///         to the owner, the vault is fixed at deployment, and the router holds nothing after any
///         call. A permit seen in flight and sent first changes nothing; a signature that does not
///         authorize the call moves nothing.
contract SavingsRouterTest is RouterFixture {
    uint256 internal constant SAVED = 100 * uint256(DOLLAR);

    /// @dev A signature no permit accepts, for calls that must not rely on one.
    Sig internal junk;

    function setUp() public override {
        super.setUp();
        ausd.mint(saver, SAVED);
        junk = Sig({v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(1))});
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_fixesOneVaultPerAsset() public view {
        assertEq(router.vaultFor(address(ausd)), address(savings));
        assertEq(router.vaultFor(address(usd)), address(plainVault));
        assertEq(router.vaultFor(address(refusing)), address(0));

        ISavingsRouter.Route[] memory list = router.routes();
        assertEq(list.length, 2);
        assertEq(list[0].asset, address(ausd));
        assertEq(list[0].vault, address(savings));
        assertEq(list[1].asset, address(usd));
        assertEq(list[1].vault, address(plainVault));
    }

    function test_refusesNoRoutes() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidAsset.selector, address(0)));
        new SavingsRouter(new address[](0), new address[](0));
    }

    function test_refusesListsOfDifferentLengths() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.LengthMismatch.selector, 2, 1));
        new SavingsRouter(pair(address(ausd), address(usd)), one(address(savings)));
    }

    function test_refusesAZeroAsset() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidAsset.selector, address(0)));
        new SavingsRouter(one(address(0)), one(address(savings)));
    }

    function test_refusesAnAssetWithNoCode() public {
        address nothing = makeAddr("no token here");
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidAsset.selector, nothing));
        new SavingsRouter(one(nothing), one(address(savings)));
    }

    function test_refusesTheSameAssetTwice() public {
        MockVault second = new MockVault(ausd);
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidAsset.selector, address(ausd)));
        new SavingsRouter(pair(address(ausd), address(ausd)), pair(address(savings), address(second)));
    }

    function test_refusesAZeroVault() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidVault.selector, address(ausd), address(0)));
        new SavingsRouter(one(address(ausd)), one(address(0)));
    }

    function test_refusesAVaultOverAnotherAsset() public {
        vm.expectRevert(
            abi.encodeWithSelector(ISavingsRouter.InvalidVault.selector, address(ausd), address(plainVault))
        );
        new SavingsRouter(one(address(ausd)), one(address(plainVault)));
    }

    function test_refusesAContractThatIsNotAVault() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidVault.selector, address(ausd), address(usd)));
        new SavingsRouter(one(address(ausd)), one(address(usd)));
    }

    /*//////////////////////////////////////////////////////////////
                             SIGNED DEPOSITS
    //////////////////////////////////////////////////////////////*/

    function test_relayerDepositsForASaverWithNoGas() public {
        assertEq(saver.balance, 0);
        uint256 expected = savings.previewDeposit(SAVED);
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);

        vm.expectEmit(address(router));
        emit ISavingsRouter.Deposited(saver, address(ausd), address(savings), SAVED, expected);
        vm.prank(relayer);
        uint256 shares = router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);

        assertEq(shares, expected);
        assertEq(savings.balanceOf(saver), expected);
        assertEq(savings.maxWithdraw(saver), SAVED);
        assertEq(ausd.balanceOf(saver), 0);
        assertEq(ausd.allowance(saver, address(router)), 0, "the permit is spent to zero");
        assertEq(saver.balance, 0, "the saver never needed gas");
        assertEq(savings.balanceOf(relayer), 0);
        assertEq(ausd.balanceOf(relayer), 0);
        assertRouterEmpty();
    }

    function test_aPermitSentFirstBySomeoneElseStillDeposits() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);

        // Seen in flight and sent straight to the token first.
        vm.prank(stranger);
        ausd.permit(saver, address(router), SAVED, deadline, sig.v, sig.r, sig.s);

        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);
        assertEq(savings.maxWithdraw(saver), SAVED);
        assertEq(savings.balanceOf(stranger), 0);
        assertRouterEmpty();
    }

    function test_aDepositSentFirstBySomeoneElseHappensOnce() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        ausd.mint(saver, SAVED);

        vm.prank(stranger);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);

        // The nonce is spent, so the same signature now recovers to someone else, and nothing is
        // left allowed to the router: the relayer's copy moves nothing.
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);

        assertEq(savings.maxWithdraw(saver), SAVED);
        assertEq(ausd.balanceOf(saver), SAVED);
    }

    function test_aSignatureByAnotherKeyReverts() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermitFor(STRANGER_KEY, saver, address(ausd), address(router), SAVED, deadline);

        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, stranger, saver));
        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);
    }

    function test_anExpiredSignatureReverts() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.SignatureExpired.selector, deadline, deadline + 1));
        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);
    }

    function test_theDeadlineBindsEvenAfterThePermitWasSentFirst() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        vm.prank(stranger);
        ausd.permit(saver, address(router), SAVED, deadline, sig.v, sig.r, sig.s);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.SignatureExpired.selector, deadline, deadline + 1));
        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);
    }

    function test_anAssetWithNoVaultReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.UnsupportedAsset.selector, address(refusing)));
        vm.prank(relayer);
        router.depositFor(saver, address(refusing), SAVED, T0 + 1 hours, junk.v, junk.r, junk.s);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.UnsupportedAsset.selector, address(refusing)));
        vm.prank(relayer);
        router.withdrawFor(saver, address(refusing), SAVED, SAVED, T0 + 1 hours, junk.v, junk.r, junk.s);
    }

    function test_aZeroAmountReverts() public {
        vm.expectRevert(ISavingsRouter.InvalidAmount.selector);
        router.depositFor(saver, address(ausd), 0, T0 + 1 hours, junk.v, junk.r, junk.s);

        vm.expectRevert(ISavingsRouter.InvalidAmount.selector);
        router.withdrawFor(saver, address(ausd), 0, 1, T0 + 1 hours, junk.v, junk.r, junk.s);

        vm.expectRevert(ISavingsRouter.InvalidAmount.selector);
        vm.prank(payer);
        router.deposit(address(ausd), 0);
    }

    function test_aSubmitterCannotDepositTheSaversMoneyForItself() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        ausd.mint(relayer, SAVED);

        // Named as the owner, the relayer's own funds would be the ones at stake, and the saver's
        // signature does not authorize them.
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        vm.prank(relayer);
        router.depositFor(relayer, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);

        assertEq(ausd.balanceOf(saver), SAVED);
        assertEq(ausd.balanceOf(relayer), SAVED);
    }

    function test_aPermitOnOneAssetMovesNoOther() public {
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        usd.mint(saver, SAVED);

        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        vm.prank(relayer);
        router.depositFor(saver, address(usd), SAVED, deadline, sig.v, sig.r, sig.s);
        assertEq(usd.balanceOf(saver), SAVED);
    }

    function test_everyDepositLandsInTheOneFixedVault() public {
        MockVault elsewhere = new MockVault(ausd);
        depositSigned(SAVER_KEY, address(ausd), SAVED);

        assertEq(router.vaultFor(address(ausd)), address(savings));
        assertEq(elsewhere.totalAssets(), 0);
        assertEq(ausd.balanceOf(address(savings)), SAVED);
    }

    /// @dev By design, not by accident: an allowance to the router, however it came about, can be
    ///      carried out by anyone, and only ever into the owner's own position.
    function test_aStandingAllowanceCanOnlyEverFundTheOwnersOwnSavings() public {
        vm.prank(saver);
        ausd.approve(address(router), SAVED);

        vm.prank(stranger);
        router.depositFor(saver, address(ausd), SAVED, T0 + 1 hours, junk.v, junk.r, junk.s);

        assertEq(savings.maxWithdraw(saver), SAVED);
        assertEq(savings.balanceOf(stranger), 0);
        assertEq(ausd.balanceOf(stranger), 0);
    }

    function test_aDepositThatWouldMintNothingReverts() public {
        // One share outstanding and a large donation behind it: a share now costs more than the
        // whole deposit, which would otherwise vanish into the vault.
        ausd.mint(stranger, 1);
        vm.startPrank(stranger);
        ausd.approve(address(savings), 1);
        savings.deposit(1, stranger);
        vm.stopPrank();
        ausd.mint(address(savings), 1_000 * uint256(DOLLAR));
        assertEq(savings.previewDeposit(SAVED), 0);

        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(ausd), address(router), SAVED, deadline);
        vm.expectRevert(ISavingsRouter.NothingMinted.selector);
        vm.prank(relayer);
        router.depositFor(saver, address(ausd), SAVED, deadline, sig.v, sig.r, sig.s);
    }

    function test_aStrayTransferNeverBlocksADeposit() public {
        ausd.mint(stranger, 5);
        vm.prank(stranger);
        ausd.transfer(address(router), 5);

        depositSigned(SAVER_KEY, address(ausd), SAVED);
        assertEq(savings.maxWithdraw(saver), SAVED);
        // Unreachable, and never counted as anyone's deposit.
        assertRouterEmpty(5, 0);
    }

    function test_aVaultThatTakesLessThanItIsGivenReverts() public {
        ShortPullVault short = new ShortPullVault(usd);
        SavingsRouter r = new SavingsRouter(one(address(usd)), one(address(short)));
        vm.prank(payer);
        usd.approve(address(r), SAVED);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.Residue.selector, 1, 1));
        vm.prank(payer);
        r.deposit(address(usd), SAVED);
    }

    /*//////////////////////////////////////////////////////////////
                            SIGNED WITHDRAWALS
    //////////////////////////////////////////////////////////////*/

    function test_relayerWithdrawsForASaverWithNoGas() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        vm.warp(T0 + 90 days);

        uint256 amount = 40 * uint256(DOLLAR);
        uint256 cost = savings.previewWithdraw(amount);
        assertLt(cost, amount, "after yield a share is worth more than a base unit");
        uint256 sharesBefore = savings.balanceOf(saver);
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(savings), address(router), cost, deadline);

        vm.expectEmit(address(router));
        emit ISavingsRouter.Withdrawn(saver, address(ausd), address(savings), amount, cost);
        vm.prank(relayer);
        uint256 burned = router.withdrawFor(saver, address(ausd), amount, cost, deadline, sig.v, sig.r, sig.s);

        assertEq(burned, cost);
        assertEq(ausd.balanceOf(saver), amount);
        assertEq(savings.balanceOf(saver), sharesBefore - cost);
        assertEq(savings.allowance(saver, address(router)), 0, "a bound of exactly the cost is spent to zero");
        assertEq(saver.balance, 0, "the saver never needed gas");
        assertEq(ausd.balanceOf(relayer), 0);
        assertRouterEmpty();
    }

    function test_aSharePermitSentFirstBySomeoneElseStillWithdraws() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        uint256 cost = savings.previewWithdraw(SAVED);
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(savings), address(router), cost, deadline);

        vm.prank(stranger);
        savings.permit(saver, address(router), cost, deadline, sig.v, sig.r, sig.s);

        vm.prank(relayer);
        router.withdrawFor(saver, address(ausd), SAVED, cost, deadline, sig.v, sig.r, sig.s);
        assertEq(ausd.balanceOf(saver), SAVED);
        assertEq(ausd.balanceOf(stranger), 0);
        assertRouterEmpty();
    }

    function test_aShareBoundBelowTheBurnReverts() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        uint256 cost = savings.previewWithdraw(SAVED);
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(savings), address(router), cost - 1, deadline);

        // The permit grants exactly the bound, so the vault itself refuses to burn past it.
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), cost - 1, cost)
        );
        vm.prank(relayer);
        router.withdrawFor(saver, address(ausd), SAVED, cost - 1, deadline, sig.v, sig.r, sig.s);
    }

    function test_theShareBoundHoldsEvenOverALargerStandingAllowance() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        vm.prank(saver);
        savings.approve(address(router), type(uint256).max);
        uint256 cost = savings.previewWithdraw(SAVED);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.MaxSharesExceeded.selector, cost, cost - 1));
        vm.prank(relayer);
        router.withdrawFor(saver, address(ausd), SAVED, cost - 1, T0 + 1 hours, junk.v, junk.r, junk.s);
    }

    function test_aShareSignatureByAnotherKeyReverts() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermitFor(STRANGER_KEY, saver, address(savings), address(router), SAVED, deadline);

        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, stranger, saver));
        vm.prank(relayer);
        router.withdrawFor(saver, address(ausd), SAVED, SAVED, deadline, sig.v, sig.r, sig.s);
    }

    function test_anExpiredShareSignatureReverts() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        uint256 deadline = T0 + 1 hours;
        Sig memory sig = signPermit(SAVER_KEY, address(savings), address(router), SAVED, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.SignatureExpired.selector, deadline, deadline + 1));
        vm.prank(relayer);
        router.withdrawFor(saver, address(ausd), SAVED, SAVED, deadline, sig.v, sig.r, sig.s);
    }

    /// @dev By design: a bound above what the withdrawal burns leaves the difference allowed to
    ///      the router, and anyone can use it, but only to pay the owner.
    function test_aLooseShareBoundCanOnlyEverPayTheOwner() public {
        depositSigned(SAVER_KEY, address(ausd), SAVED);
        uint256 half = SAVED / 2;
        uint256 cost = savings.previewWithdraw(half);
        withdrawSigned(SAVER_KEY, address(ausd), half, cost + 10 * uint256(DOLLAR));
        assertEq(savings.allowance(saver, address(router)), 10 * uint256(DOLLAR));

        vm.prank(stranger);
        router.withdrawFor(
            saver, address(ausd), 10 * uint256(DOLLAR), 10 * uint256(DOLLAR), T0 + 1 hours, junk.v, junk.r, junk.s
        );

        assertEq(ausd.balanceOf(saver), half + 10 * uint256(DOLLAR));
        assertEq(ausd.balanceOf(stranger), 0);
        assertEq(savings.allowance(saver, address(router)), 0);
    }

    function test_aVaultThatPaysShortReverts() public {
        vm.startPrank(payer);
        usd.approve(address(router), SAVED);
        router.deposit(address(usd), SAVED);
        plainVault.approve(address(router), type(uint256).max);
        vm.stopPrank();
        plainVault.setPaysShort(true);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.PaymentMismatch.selector, SAVED, SAVED - 1));
        vm.prank(payer);
        router.withdraw(address(usd), SAVED);
    }

    /*//////////////////////////////////////////////////////////////
                               PLAIN PATHS
    //////////////////////////////////////////////////////////////*/

    function test_aCallerWithGasDepositsAndWithdrawsDirectly() public {
        uint256 walletBefore = usd.balanceOf(payer);

        vm.startPrank(payer);
        usd.approve(address(router), SAVED);
        vm.expectEmit(address(router));
        emit ISavingsRouter.Deposited(payer, address(usd), address(plainVault), SAVED, SAVED);
        uint256 shares = router.deposit(address(usd), SAVED);
        vm.stopPrank();

        assertEq(shares, SAVED);
        assertEq(plainVault.balanceOf(payer), SAVED);
        assertEq(usd.balanceOf(payer), walletBefore - SAVED);
        assertRouterEmpty();

        // A month of yield: every share is now worth more.
        usd.mint(address(plainVault), 10 * uint256(DOLLAR));
        uint256 cost = plainVault.previewWithdraw(SAVED);

        vm.startPrank(payer);
        plainVault.approve(address(router), cost);
        vm.expectEmit(address(router));
        emit ISavingsRouter.Withdrawn(payer, address(usd), address(plainVault), SAVED, cost);
        uint256 burned = router.withdraw(address(usd), SAVED);
        vm.stopPrank();

        assertEq(burned, cost);
        assertEq(usd.balanceOf(payer), walletBefore);
        assertEq(plainVault.balanceOf(payer), SAVED - cost);
        assertRouterEmpty();
    }

    function test_aPlainDepositNeedsAnAllowance() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, SAVED)
        );
        vm.prank(payer);
        router.deposit(address(usd), SAVED);
    }

    /// @dev The plain vault's shares take no `permit`: the call reverts inside the vault, and an
    ///      owner who approved the router still gets through.
    function test_aVaultWithoutSharePermitsServesAnOwnerWhoApproved() public {
        vm.startPrank(payer);
        usd.approve(address(router), SAVED);
        router.deposit(address(usd), SAVED);
        plainVault.approve(address(router), SAVED);
        vm.stopPrank();

        vm.prank(relayer);
        router.withdrawFor(payer, address(usd), SAVED, SAVED, T0 + 1 hours, junk.v, junk.r, junk.s);
        assertEq(plainVault.balanceOf(payer), 0);
        assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                                REENTRANCY
    //////////////////////////////////////////////////////////////*/

    function test_reentryThroughTheTokenIsRefused() public {
        ReentrantToken token = new ReentrantToken();
        MockVault vault = new MockVault(IERC20(address(token)));
        SavingsRouter r = new SavingsRouter(one(address(token)), one(address(vault)));
        token.mint(payer, SAVED);
        vm.prank(payer);
        token.approve(address(r), SAVED);

        token.arm(address(r), abi.encodeCall(SavingsRouter.deposit, (address(token), 1)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(payer);
        r.deposit(address(token), SAVED);
    }

    function test_reentryThroughTheVaultIsRefused() public {
        ReentrantVault vault = new ReentrantVault(usd);
        SavingsRouter r = new SavingsRouter(one(address(usd)), one(address(vault)));
        vm.startPrank(payer);
        usd.approve(address(r), type(uint256).max);
        vault.approve(address(r), type(uint256).max);
        vm.stopPrank();

        vault.arm(address(r), abi.encodeCall(SavingsRouter.withdraw, (address(usd), 1)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(payer);
        r.deposit(address(usd), SAVED);

        // The revert rolled the disarm back with everything else.
        vault.arm(address(0), "");
        vm.prank(payer);
        r.deposit(address(usd), SAVED);

        vault.arm(address(r), abi.encodeCall(SavingsRouter.deposit, (address(usd), 1)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(payer);
        r.withdraw(address(usd), SAVED);
    }

    /*//////////////////////////////////////////////////////////////
                               END TO END
    //////////////////////////////////////////////////////////////*/

    /// @dev The whole of "earn until charged" for a payer who never holds a gas token: the faucet
    ///      funds a fresh key, the relayer deposits it into savings on the payer's permit, installs
    ///      a mandate drawing from the vault on the payer's share permit and signed terms, and each
    ///      charge withdraws exactly the amount due, straight to the merchant, while the rest earns.
    function test_aPayerWithNoGasSavesAndIsChargedFromSavings() public {
        uint256 key = 0xE2E;
        address p = vm.addr(key);
        ausd.mint(p, 120 * uint256(DOLLAR));
        uint256 deadline = T0 + 1 hours;

        uint256 shares = depositSigned(key, address(ausd), 120 * uint256(DOLLAR));
        assertEq(savings.balanceOf(p), shares);
        assertEq(ausd.balanceOf(p), 0);

        IMandateHub.Terms memory t = monthly();
        t.asset = address(ausd);
        t.vault = address(savings);
        Sig memory sharePermit = signPermit(key, address(savings), address(hub), type(uint256).max, deadline);
        bytes memory terms = signCreate(key, p, t, 1, deadline);

        vm.startPrank(relayer);
        savings.permit(p, address(hub), type(uint256).max, deadline, sharePermit.v, sharePermit.r, sharePermit.s);
        uint256 id = hub.createMandateWithSig(p, t, 1, deadline, terms);
        vm.stopPrank();

        uint256 saved = savings.maxWithdraw(p);
        hub.charge(id);
        assertEq(ausd.balanceOf(merchant), 10 * uint256(DOLLAR));
        assertApproxEqAbs(savings.maxWithdraw(p), saved - 10 * uint256(DOLLAR), 1);

        vm.warp(T0 + MONTH);
        uint256 earned = savings.maxWithdraw(p);
        assertGt(earned, saved - 10 * uint256(DOLLAR), "the rest earned for a month");
        hub.charge(id);
        assertEq(ausd.balanceOf(merchant), 20 * uint256(DOLLAR));
        assertApproxEqAbs(savings.maxWithdraw(p), earned - 10 * uint256(DOLLAR), 1);

        uint256 rest = savings.maxWithdraw(p);
        withdrawSigned(key, address(ausd), rest, savings.previewWithdraw(rest));
        assertEq(ausd.balanceOf(p), rest);
        assertEq(ausd.balanceOf(address(hub)), 0);
        assertEq(p.balance, 0, "the payer never held gas");
        assertRouterEmpty();
    }
}
