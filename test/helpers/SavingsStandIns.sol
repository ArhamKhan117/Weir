// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {MockVault} from "../mocks/MockVault.sol";

/// @title SavingsStandIns
/// @notice Stand-ins for the tokens and savings vaults the deploy scripts name on each network,
///         placed at their real addresses so the scripts can run in a test.
/// @dev The addresses are restated here rather than read from the script, so a change to its
///      constants shows up as a failing test. A vault stand-in answers `asset()` from an immutable,
///      which survives `vm.etch`; nothing the router checks lives in storage.
abstract contract SavingsStandIns is Test {
    address internal constant MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant MAINNET_AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant MAINNET_USDC_VAULT = 0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59;
    address internal constant MAINNET_AUSD_VAULT = 0xbe3E6d3F857812B4731677C88288D4F3afF8E9a1;
    address internal constant TESTNET_TAUSD = 0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9;
    address internal constant TESTNET_SAVINGS_VAULT = 0xe0cd535d298DAd5e228486a79A21176349825B8d;

    /// @dev A token at `asset`, and at `vault` a vault whose `asset()` is `over`.
    function standIn(address asset, address vault, address over) internal {
        vm.etch(asset, address(new TestStablecoin("Stand-in", "SI")).code);
        vm.etch(vault, address(new MockVault(IERC20(over))).code);
    }

    function standInTestnet() internal {
        standIn(TESTNET_TAUSD, TESTNET_SAVINGS_VAULT, TESTNET_TAUSD);
    }

    /// @dev The Testnet test token and savings vault exactly as `Deploy` builds them, constructed
    ///      in place at their real addresses, so their names, permit domains and `asset()` read
    ///      what the chain holds. What a redeploy that reuses them checks.
    function standInTestnetAsDeployed() internal {
        deployCodeTo("TestStablecoin.sol:TestStablecoin", abi.encode("Test AUSD", "tAUSD"), TESTNET_TAUSD);
        deployCodeTo(
            "TestSavingsVault.sol:TestSavingsVault",
            abi.encode(TESTNET_TAUSD, "Test AUSD Savings", "stAUSD"),
            TESTNET_SAVINGS_VAULT
        );
    }

    function standInMainnet() internal {
        standIn(MAINNET_USDC, MAINNET_USDC_VAULT, MAINNET_USDC);
        standIn(MAINNET_AUSD, MAINNET_AUSD_VAULT, MAINNET_AUSD);
    }
}
