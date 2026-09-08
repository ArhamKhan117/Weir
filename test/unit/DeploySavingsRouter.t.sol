// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {DeploySavingsRouter} from "../../script/DeploySavingsRouter.s.sol";
import {SavingsRouter} from "../../src/SavingsRouter.sol";
import {ISavingsRouter} from "../../src/interfaces/ISavingsRouter.sol";
import {SavingsStandIns} from "../helpers/SavingsStandIns.sol";

/// @title DeploySavingsRouterTest
/// @notice The router deploy script ships exactly the routes of the chain it runs on, refuses a
///         vault whose asset is not the one it is paired with, and ships nothing on a chain it does
///         not know.
/// @dev `run` reads `MONAD_CHAIN_ID`, and `vm.setEnv` is process-wide while Foundry runs every
///      suite in parallel, so its case lives in the one test in `Deploy.t.sol` that writes the
///      environment, beside the hub script's.
contract DeploySavingsRouterTest is SavingsStandIns {
    DeploySavingsRouter internal script;

    function setUp() public {
        script = new DeploySavingsRouter();
    }

    function test_testnetRoutesTheTestTokenToItsSavingsVault() public {
        vm.chainId(10143);
        standInTestnet();
        SavingsRouter router = script.deploy();

        ISavingsRouter.Route[] memory list = router.routes();
        assertEq(list.length, 1);
        assertEq(list[0].asset, TESTNET_TAUSD);
        assertEq(list[0].vault, TESTNET_SAVINGS_VAULT);
        assertEq(router.vaultFor(TESTNET_TAUSD), TESTNET_SAVINGS_VAULT);
    }

    function test_mainnetRoutesUsdcAndAusdToTheirVaults() public {
        vm.chainId(143);
        standInMainnet();
        SavingsRouter router = script.deploy();

        ISavingsRouter.Route[] memory list = router.routes();
        assertEq(list.length, 2);
        assertEq(list[0].asset, MAINNET_USDC);
        assertEq(list[0].vault, MAINNET_USDC_VAULT);
        assertEq(list[1].asset, MAINNET_AUSD);
        assertEq(list[1].vault, MAINNET_AUSD_VAULT);
    }

    function test_refusesAVaultOverTheWrongAsset() public {
        vm.chainId(143);
        standIn(MAINNET_USDC, MAINNET_USDC_VAULT, MAINNET_USDC);
        standIn(MAINNET_AUSD, MAINNET_AUSD_VAULT, MAINNET_USDC);

        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidVault.selector, MAINNET_AUSD, MAINNET_AUSD_VAULT));
        script.deploy();
    }

    function test_refusesAChainWithoutTheAssets() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(ISavingsRouter.InvalidAsset.selector, MAINNET_USDC));
        script.deploy();
    }

    function test_refusesAnUnknownChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeploySavingsRouter.UnsupportedChain.selector, 1));
        script.deploy();
    }
}
