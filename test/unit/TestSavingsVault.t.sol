// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {MandateHub} from "../../src/MandateHub.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {TestSavingsVault} from "../../src/testnet/TestSavingsVault.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title TestSavingsVaultTest
/// @notice The Testnet savings vault earns its simulated rate, always pays what it owes, and
///         works as the source of a mandate exactly as a real ERC-4626 vault does.
contract TestSavingsVaultTest is HubFixture {
    TestSavingsVault internal savings;

    function setUp() public override {
        super.setUp();
        savings = new TestSavingsVault(ausd, "Test AUSD Savings", "stAUSD");

        vm.startPrank(payer);
        ausd.approve(address(savings), 1_000 * DOLLAR);
        savings.deposit(1_000 * DOLLAR, payer);
        vm.stopPrank();
    }

    function test_earnsItsRateOverAYear() public {
        vm.warp(T0 + 365 days);
        assertEq(savings.maxWithdraw(payer), 1_050 * DOLLAR - 1);
    }

    function test_paysEverythingItOwes() public {
        vm.warp(T0 + 365 days);
        uint256 owed = savings.maxWithdraw(payer);

        vm.prank(payer);
        savings.withdraw(owed, payer, payer);
        assertEq(ausd.balanceOf(payer), owed);
    }

    function test_accrualKeepsTheSharePrice() public {
        vm.warp(T0 + 100 days);
        uint256 before = savings.convertToAssets(1e6);
        savings.accrue();
        assertEq(savings.convertToAssets(1e6), before);
    }

    function test_mintsLargeInterestInFaucetSizedChunks() public {
        address whale = makeAddr("whale");
        for (uint256 i = 0; i < 30; ++i) {
            ausd.mint(whale, ausd.MAX_MINT());
        }
        vm.startPrank(whale);
        ausd.approve(address(savings), type(uint256).max);
        savings.deposit(ausd.balanceOf(whale), whale);
        vm.stopPrank();

        vm.warp(T0 + 365 days);
        savings.accrue();
        assertGt(ausd.balanceOf(address(savings)), 300_000 * uint256(DOLLAR));
    }

    function test_sharesSupportPermit() public {
        uint256 key = 0xF2E5;
        address saver = vm.addr(key);
        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                saver,
                address(hub),
                uint256(1),
                savings.nonces(saver),
                T0 + 1 hours
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", savings.DOMAIN_SEPARATOR(), permitHash)));

        savings.permit(saver, address(hub), 1, T0 + 1 hours, v, r, s);
        assertEq(savings.allowance(saver, address(hub)), 1);
    }

    function test_aMandateEarnsUntilCharged() public {
        vm.prank(payer);
        savings.approve(address(hub), type(uint256).max);

        IMandateHub.Terms memory t = monthly();
        t.asset = address(ausd);
        t.vault = address(savings);
        uint256 id = create(t);

        vm.warp(T0 + 365 days);
        hub.charge(id);

        assertEq(ausd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(savings.maxWithdraw(payer), 1_040 * DOLLAR - 1);
    }
}
