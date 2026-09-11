// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ISavingsRouter} from "../../src/interfaces/ISavingsRouter.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {RouterFixture} from "../helpers/RouterFixture.sol";

/// @title SavingsRouterFuzzTest
/// @notice For any saver key, amount, submitter and share price (other savers in the vault, yield
///         accruing over any stretch of time, and arbitrary value landing in the vault on top), a
///         signed deposit moves exactly the amount from the owner's wallet into the vault and
///         mints exactly the vault's own `previewDeposit` of it to the owner, or reverts
///         `NothingMinted` when that is zero; a signed withdrawal pays exactly the amount to the
///         owner and burns exactly the vault's `previewWithdraw` of it, never more than the owner's
///         bound. The submitter gains nothing, nobody else's position moves, and the router holds
///         no asset, no share and no allowance after any call, across any sequence of them. A
///         signature by any other key, or submitted for any other owner, moves nothing.
contract SavingsRouterFuzzTest is RouterFixture {
    /// @dev Another saver in the same vault, whose position no call here may touch.
    address internal other;

    /// @dev One signed call as submitted.
    struct Call {
        uint256 key;
        address owner;
        address caller;
        uint256 amount;
        uint256 maxShares;
        uint256 deadline;
        Sig sig;
    }

    /// @dev Everything a call may and may not move.
    struct Position {
        uint256 ownerWallet;
        uint256 ownerShares;
        uint256 otherShares;
        uint256 vaultAssets;
        uint256 callerWallet;
        uint256 callerShares;
    }

    function setUp() public override {
        super.setUp();
        other = makeAddr("other saver");
    }

    /*//////////////////////////////////////////////////////////////
                                 DEPOSITS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_signedDepositMintsExactlyThePreviewToTheOwner(
        uint256 keySeed,
        uint256 amount,
        uint256 othersSaved,
        uint256 elapsed,
        uint256 windfall,
        address callerSeed
    ) public {
        Call memory c = _call(keySeed, callerSeed);
        _market(othersSaved, elapsed, windfall);
        c.deadline = block.timestamp + 1 hours;

        c.amount = bound(amount, 1, 1e11);
        _mint(ausd, c.owner, c.amount);
        uint256 expected = savings.previewDeposit(c.amount);
        c.sig = signPermit(c.key, address(ausd), address(router), c.amount, c.deadline);
        Position memory before = _position(c);

        if (expected == 0) {
            vm.expectRevert(ISavingsRouter.NothingMinted.selector);
            _deposit(c);
            return;
        }

        vm.expectEmit(address(router));
        emit ISavingsRouter.Deposited(c.owner, address(ausd), address(savings), c.amount, expected);
        uint256 shares = _deposit(c);

        Position memory afterwards = _position(c);
        assertEq(shares, expected, "the vault's own preview");
        assertEq(afterwards.ownerShares, before.ownerShares + expected, "shares to the owner");
        assertEq(afterwards.ownerWallet, before.ownerWallet - c.amount, "exactly the amount from the owner");
        assertEq(afterwards.vaultAssets, before.vaultAssets + c.amount, "exactly the amount into the vault");
        _assertUntouched(before, afterwards);
        assertEq(ausd.allowance(c.owner, address(router)), 0, "the permit is spent to zero");
        assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                               WITHDRAWALS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_signedWithdrawalPaysExactlyTheAmountAndBurnsThePreview(
        uint256 keySeed,
        uint256 saved,
        uint256 amount,
        uint256 othersSaved,
        uint256 elapsed,
        uint256 windfall,
        uint256 slack,
        address callerSeed
    ) public {
        Call memory c = _call(keySeed, callerSeed);
        _save(c.key, othersSaved, bound(saved, 1, 1e11));
        _grow(elapsed, windfall);
        c.deadline = block.timestamp + 1 hours;

        c.amount = bound(amount, 1, savings.maxWithdraw(c.owner));
        uint256 cost = savings.previewWithdraw(c.amount);
        c.maxShares = cost + bound(slack, 0, 1e12);
        c.sig = signPermit(c.key, address(savings), address(router), c.maxShares, c.deadline);
        Position memory before = _position(c);

        vm.expectEmit(address(router));
        emit ISavingsRouter.Withdrawn(c.owner, address(ausd), address(savings), c.amount, cost);
        uint256 burned = _withdraw(c);

        Position memory afterwards = _position(c);
        assertEq(burned, cost, "the vault's own preview");
        assertLe(burned, c.maxShares, "within the owner's bound");
        assertEq(afterwards.ownerWallet, before.ownerWallet + c.amount, "exactly the amount to the owner");
        assertEq(afterwards.ownerShares, before.ownerShares - cost, "exactly the cost from the owner");
        assertEq(afterwards.vaultAssets, before.vaultAssets - c.amount, "exactly the amount out of the vault");
        _assertUntouched(before, afterwards);
        assertEq(
            savings.allowance(c.owner, address(router)), c.maxShares - cost, "only the unburned bound stays allowed"
        );
        assertRouterEmpty();
    }

    /// @dev A bound below what the withdrawal burns reverts whether the permit granted exactly the
    ///      bound, when the vault itself refuses, or the owner had already allowed the router more,
    ///      when the router does.
    function testFuzz_aShareBoundBelowTheBurnMovesNothing(
        uint256 keySeed,
        uint256 saved,
        uint256 amount,
        uint256 elapsed,
        uint256 windfall,
        uint256 shortBy,
        bool standing
    ) public {
        uint256 key = boundPrivateKey(keySeed);
        address owner = vm.addr(key);
        _save(key, 0, bound(saved, 1, 1e11));
        _grow(elapsed, windfall);

        amount = bound(amount, 1, savings.maxWithdraw(owner));
        uint256 cost = savings.previewWithdraw(amount);
        uint256 maxShares = cost - bound(shortBy, 1, cost);
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermit(key, address(savings), address(router), maxShares, deadline);

        if (standing) {
            // No usable permit at all: the call rests on the standing allowance alone.
            vm.prank(owner);
            savings.approve(address(router), type(uint256).max);
            sig = Sig({v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(1))});
            vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.MaxSharesExceeded.selector, cost, maxShares));
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientAllowance.selector, address(router), maxShares, cost
                )
            );
        }
        vm.prank(relayer);
        router.withdrawFor(owner, address(ausd), amount, maxShares, deadline, sig.v, sig.r, sig.s);
    }

    /*//////////////////////////////////////////////////////////////
                              AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Any other key's signature is refused with the token's own error, on either path, and
    ///      the owner's wallet and savings stay exactly as they were.
    function testFuzz_aSignatureByAnyOtherKeyMovesNothing(
        uint256 keySeed,
        uint256 signerSeed,
        uint256 amount,
        bool withdrawing
    ) public {
        uint256 key = boundPrivateKey(keySeed);
        uint256 signer = boundPrivateKey(signerSeed);
        if (signer == key) signer = key == 1 ? 2 : key - 1;
        address owner = vm.addr(key);
        amount = bound(amount, 1, 1e11);
        _save(key, 0, amount);

        address token = withdrawing ? address(savings) : address(ausd);
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermitFor(signer, owner, token, address(router), amount, deadline);
        uint256 walletBefore = ausd.balanceOf(owner);
        uint256 sharesBefore = savings.balanceOf(owner);

        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, vm.addr(signer), owner));
        vm.prank(relayer);
        if (withdrawing) router.withdrawFor(owner, address(ausd), amount, amount, deadline, sig.v, sig.r, sig.s);
        else router.depositFor(owner, address(ausd), amount, deadline, sig.v, sig.r, sig.s);

        assertEq(ausd.balanceOf(owner), walletBefore);
        assertEq(savings.balanceOf(owner), sharesBefore);
    }

    /// @dev A submitter that names anyone but the signer as the owner, itself included, is refused,
    ///      and the signer's funds stay where they were.
    function testFuzz_theSignatureWorksOnlyForTheSigner(uint256 keySeed, uint256 amount, address named) public {
        uint256 key = boundPrivateKey(keySeed);
        address owner = vm.addr(key);
        vm.assume(named != owner);
        amount = bound(amount, 1, 1e11);
        _mint(ausd, owner, amount);
        uint256 walletBefore = ausd.balanceOf(owner);
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermit(key, address(ausd), address(router), amount, deadline);

        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        vm.prank(relayer);
        router.depositFor(named, address(ausd), amount, deadline, sig.v, sig.r, sig.s);

        assertEq(ausd.balanceOf(owner), walletBefore);
        assertEq(savings.balanceOf(owner), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             HOLDING NOTHING
    //////////////////////////////////////////////////////////////*/

    /// @dev Eight steps, each a signed or plain deposit or withdrawal by one of two savers on
    ///      either route, with time passing and value landing in both vaults between them. After
    ///      every step the router holds no asset, no share and no allowance, and every step moved
    ///      exactly its amount between the owner's wallet and the vault.
    function testFuzz_theRouterNeverHoldsAnything(
        uint8[8] memory kinds,
        uint256[8] memory amounts,
        uint32[8] memory gaps,
        uint256[8] memory windfalls
    ) public {
        uint256[2] memory keys = [SAVER_KEY, uint256(0xB0B)];
        for (uint256 k = 0; k < keys.length; ++k) {
            address owner = vm.addr(keys[k]);
            _mint(ausd, owner, 1e11);
            _mint(usd, owner, 1e11);
            vm.startPrank(owner);
            usd.approve(address(router), type(uint256).max);
            plainVault.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }

        for (uint256 i = 0; i < kinds.length; ++i) {
            uint256 key = keys[kinds[i] % 2];
            bool signedRoute = (kinds[i] >> 1) % 2 == 0;
            bool depositing = (kinds[i] >> 2) % 2 == 0;
            _step(key, signedRoute, depositing, amounts[i]);
            assertRouterEmpty();

            // Yield, and value landing on top of it: at most doubling either vault per step.
            vm.warp(block.timestamp + bound(gaps[i], 0, 30 days));
            _mint(ausd, address(savings), bound(windfalls[i], 0, savings.totalAssets()));
            _mint(usd, address(plainVault), bound(windfalls[i], 0, plainVault.totalAssets()));
        }
    }

    /// @dev One step of the sequence: the signed route is AUSD into the savings vault by permit,
    ///      the plain one USD into the plain vault by the owner's own call. A withdrawal with
    ///      nothing to withdraw deposits instead, so every step moves something.
    function _step(uint256 key, bool signedRoute, bool depositing, uint256 amount) internal {
        address owner = vm.addr(key);
        TestStablecoin token = signedRoute ? ausd : usd;
        uint256 available = signedRoute ? savings.maxWithdraw(owner) : plainVault.maxWithdraw(owner);
        uint256 walletBefore = token.balanceOf(owner);
        if (available == 0) depositing = true;
        if (walletBefore == 0) depositing = false;

        uint256 deadline = block.timestamp + 1 hours;
        if (depositing) {
            amount = bound(amount, 1, walletBefore);
            uint256 expected = signedRoute ? savings.previewDeposit(amount) : plainVault.previewDeposit(amount);
            Sig memory sig = signPermit(key, address(ausd), address(router), amount, deadline);
            if (expected == 0) vm.expectRevert(ISavingsRouter.NothingMinted.selector);
            if (signedRoute) {
                vm.prank(relayer);
                router.depositFor(owner, address(ausd), amount, deadline, sig.v, sig.r, sig.s);
            } else {
                vm.prank(owner);
                router.deposit(address(usd), amount);
            }
            if (expected != 0) assertEq(token.balanceOf(owner), walletBefore - amount, "deposit moved the amount");
        } else {
            amount = bound(amount, 1, available);
            if (signedRoute) {
                withdrawSigned(key, address(ausd), amount, savings.previewWithdraw(amount));
            } else {
                vm.prank(owner);
                router.withdraw(address(usd), amount);
            }
            assertEq(token.balanceOf(owner), walletBefore + amount, "withdrawal paid the amount");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Another saver's deposit, then any stretch of simulated yield, then arbitrary value
    ///      landing in the vault on top: together any share price the vault can reach.
    function _market(uint256 othersSaved, uint256 elapsed, uint256 windfall) internal {
        _otherSaves(bound(othersSaved, 0, 1e11));
        _grow(elapsed, windfall);
    }

    /// @dev Another saver's deposit and the owner's own, at the price before any yield, so the
    ///      owner always holds shares.
    function _save(uint256 key, uint256 othersSaved, uint256 saved) internal {
        _otherSaves(bound(othersSaved, 0, 1e11));
        _mint(ausd, vm.addr(key), saved);
        depositSigned(key, address(ausd), saved);
    }

    function _otherSaves(uint256 amount) internal {
        if (amount == 0) return;
        _mint(ausd, other, amount);
        vm.startPrank(other);
        ausd.approve(address(savings), amount);
        savings.deposit(amount, other);
        vm.stopPrank();
    }

    /// @dev Up to five years of simulated yield, then up to a million dollars landing on top.
    function _grow(uint256 elapsed, uint256 windfall) internal {
        vm.warp(block.timestamp + bound(elapsed, 0, 5 * 365 days));
        _mint(ausd, address(savings), bound(windfall, 0, 1e12));
    }

    /// @dev The test faucet caps each mint, so larger amounts go in capped pieces.
    function _mint(TestStablecoin token, address to, uint256 amount) internal {
        uint256 cap = token.MAX_MINT();
        while (amount > 0) {
            uint256 piece = amount < cap ? amount : cap;
            token.mint(to, piece);
            amount -= piece;
        }
    }

    /// @dev A submitter that is neither the owner, the router, the vault nor the zero address.
    function _callerFrom(address candidate, address owner) internal view returns (address) {
        if (
            candidate == address(0) || candidate == owner || candidate == address(router)
                || candidate == address(savings) || candidate == other
        ) {
            candidate = address(uint160(uint256(keccak256(abi.encode("caller", candidate, owner)))));
        }
        return candidate;
    }

    /// @dev A saver key from `keySeed` and a submitter that is not the saver. The deadline is set
    ///      once the clock has moved.
    function _call(uint256 keySeed, address callerSeed) internal view returns (Call memory c) {
        c.key = boundPrivateKey(keySeed);
        c.owner = vm.addr(c.key);
        c.caller = _callerFrom(callerSeed, c.owner);
    }

    function _deposit(Call memory c) internal returns (uint256) {
        vm.prank(c.caller);
        return router.depositFor(c.owner, address(ausd), c.amount, c.deadline, c.sig.v, c.sig.r, c.sig.s);
    }

    function _withdraw(Call memory c) internal returns (uint256) {
        vm.prank(c.caller);
        return router.withdrawFor(c.owner, address(ausd), c.amount, c.maxShares, c.deadline, c.sig.v, c.sig.r, c.sig.s);
    }

    function _position(Call memory c) internal view returns (Position memory p) {
        p.ownerWallet = ausd.balanceOf(c.owner);
        p.ownerShares = savings.balanceOf(c.owner);
        p.otherShares = savings.balanceOf(other);
        p.vaultAssets = savings.totalAssets();
        p.callerWallet = ausd.balanceOf(c.caller);
        p.callerShares = savings.balanceOf(c.caller);
    }

    /// @dev Nobody but the owner moved: not the other saver, and not the submitter.
    function _assertUntouched(Position memory before, Position memory afterwards) internal pure {
        assertEq(afterwards.otherShares, before.otherShares, "nobody else's position");
        assertEq(afterwards.callerWallet, before.callerWallet, "the submitter's wallet");
        assertEq(afterwards.callerShares, before.callerShares, "the submitter's shares");
    }
}
